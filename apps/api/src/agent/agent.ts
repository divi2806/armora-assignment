import { randomUUID } from "node:crypto";
import { evaluatePolicy } from "../../../../packages/policy-engine/src";
import type {
  AgentRunResult,
  ApprovalRequest,
  AuditLog,
  Conversation,
  ConversationMessage,
  ToolIntent
} from "../../../../packages/shared/src/types";
import { mcpRegistry } from "../mcp/registry";
import { broadcast } from "../store/events";
import { addLog, state } from "../store/state";
import { planWithOpenAI, synthesizeWithOpenAI } from "./openaiProvider";

function message(role: ConversationMessage["role"], content: string): ConversationMessage {
  return {
    role,
    content,
    timestamp: new Date().toISOString()
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: Array<{ text?: string; type?: string }> }).content;
    if (Array.isArray(content)) {
      return content.map((item) => item.text ?? JSON.stringify(item)).join("\n");
    }
  }
  return JSON.stringify(result, null, 2);
}

function ensureConversation(conversationId?: string): Conversation {
  const existing = conversationId ? state.conversations.find((item) => item.id === conversationId) : undefined;
  if (existing) return existing;

  const created: Conversation = {
    id: conversationId ?? randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    declaredIntent: "Pending",
    budgetUsed: 0,
    messages: []
  };
  state.conversations.unshift(created);
  return created;
}

function makeIntent(conversation: Conversation, userMessage: string, toolId: string, args: Record<string, unknown>): ToolIntent {
  const tool = state.tools.find((candidate) => candidate.id === toolId);
  if (!tool) throw new Error(`Unknown discovered tool: ${toolId}`);
  return {
    conversationId: conversation.id,
    userMessage,
    declaredIntent: conversation.declaredIntent,
    serverId: tool.serverId,
    toolName: tool.name,
    toolId: tool.id,
    args,
    estimatedCost: 1
  };
}

export async function runAgent(userMessage: string, conversationId?: string): Promise<AgentRunResult> {
  await mcpRegistry.refresh();
  const conversation = ensureConversation(conversationId);
  conversation.messages.push(message("user", userMessage));

  addLog({
    actor: "agent",
    conversationId: conversation.id,
    event: "conversation_started",
    message: "Agent received user request and captured declared intent."
  });

  const plan = await planWithOpenAI({ message: userMessage, tools: state.tools });
  conversation.declaredIntent = plan.declaredIntent;
  const toolEvents: AuditLog[] = [];
  const toolResults: Array<{ toolId: string; result: string }> = [];
  const policyNotes: string[] = [];

  for (const planned of plan.toolCalls.slice(0, 5)) {
    const intent = makeIntent(conversation, userMessage, planned.toolId, planned.args);
    const intentLog = addLog({
      actor: "agent",
      conversationId: conversation.id,
      event: "tool_intent",
      message: `Agent proposed ${intent.toolId}`,
      serverId: intent.serverId,
      toolName: intent.toolName,
      metadata: {
        args: intent.args,
        rationale: planned.rationale,
        declaredIntent: intent.declaredIntent
      }
    });
    toolEvents.push(intentLog);

    const decision = evaluatePolicy({
      intent,
      rules: state.rules,
      currentBudget: conversation.budgetUsed
    });

    if (decision.verdict === "block") {
      const blocked = addLog({
        actor: "system",
        conversationId: conversation.id,
        event: "policy_block",
        message: decision.reason,
        serverId: intent.serverId,
        toolName: intent.toolName,
        verdict: "block",
        ruleIds: decision.matchedRuleIds,
        metadata: { args: intent.args, severity: decision.severity }
      });
      toolEvents.push(blocked);
      policyNotes.push(`${intent.toolId}: ${decision.reason}`);
      conversation.messages.push(message("system", `Blocked ${intent.toolId}: ${decision.reason}`));
      continue;
    }

    if (decision.verdict === "approval_required") {
      const approval: ApprovalRequest = {
        id: randomUUID(),
        conversationId: conversation.id,
        createdAt: new Date().toISOString(),
        status: "pending",
        toolIntent: intent,
        decision
      };
      decision.requiresApprovalId = approval.id;
      state.approvals.unshift(approval);
      const approvalLog = addLog({
        actor: "system",
        conversationId: conversation.id,
        event: "approval_requested",
        message: decision.reason,
        serverId: intent.serverId,
        toolName: intent.toolName,
        verdict: "approval_required",
        ruleIds: decision.matchedRuleIds,
        metadata: { approvalId: approval.id, args: intent.args }
      });
      toolEvents.push(approvalLog);
      policyNotes.push(`${intent.toolId}: ${decision.reason}`);
      conversation.messages.push(message("system", `Approval queued for ${intent.toolId}.`));
      continue;
    }

    try {
      const allowLog = addLog({
        actor: "system",
        conversationId: conversation.id,
        event: "policy_allow",
        message: decision.reason,
        serverId: intent.serverId,
        toolName: intent.toolName,
        verdict: "allow",
        ruleIds: decision.matchedRuleIds,
        metadata: { args: intent.args }
      });
      toolEvents.push(allowLog);

      const result = await mcpRegistry.callTool(intent.serverId, intent.toolName, intent.args);
      const resultText = stringifyToolResult(result);
      conversation.budgetUsed += intent.estimatedCost;
      toolResults.push({ toolId: intent.toolId, result: resultText });
      conversation.messages.push(message("tool", `${intent.toolId}\n${resultText}`));
      toolEvents.push(
        addLog({
          actor: "agent",
          conversationId: conversation.id,
          event: "tool_result",
          message: `${intent.toolId} executed after policy allow.`,
          serverId: intent.serverId,
          toolName: intent.toolName,
          metadata: { result: resultText.slice(0, 2000) }
        })
      );
    } catch (error) {
      const errorLog = addLog({
        actor: "system",
        conversationId: conversation.id,
        event: "tool_error",
        message: `${intent.toolId} failed safely; no retry bypass was attempted.`,
        serverId: intent.serverId,
        toolName: intent.toolName,
        metadata: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      toolEvents.push(errorLog);
      conversation.messages.push(message("system", `Tool failed safely: ${errorLog.metadata?.error}`));
    }
  }

  const modelAnswer = await synthesizeWithOpenAI({
    message: userMessage,
    declaredIntent: conversation.declaredIntent,
    toolResults,
    policyNotes
  });
  const answer = modelAnswer ?? buildAnswer(userMessage, conversation, toolResults);
  conversation.messages.push(message("assistant", answer));
  conversation.updatedAt = new Date().toISOString();
  broadcast("agent");
  return { conversation, answer, toolEvents };
}

export async function resolveApproval(approvalId: string, approved: boolean, reason: string) {
  const approval = state.approvals.find((item) => item.id === approvalId);
  if (!approval) throw new Error("Approval request not found.");
  if (approval.status !== "pending") throw new Error("Approval is already resolved.");

  approval.status = approved ? "approved" : "denied";
  approval.resolvedAt = new Date().toISOString();
  approval.resolvedBy = "dashboard-admin";
  approval.resolutionReason = reason;

  addLog({
    actor: "admin",
    conversationId: approval.conversationId,
    event: "approval_resolved",
    message: approved ? "Admin approved queued tool execution." : "Admin denied queued tool execution.",
    serverId: approval.toolIntent.serverId,
    toolName: approval.toolIntent.toolName,
    metadata: { approvalId, reason }
  });

  if (approved) {
    try {
      const result = await mcpRegistry.callTool(
        approval.toolIntent.serverId,
        approval.toolIntent.toolName,
        approval.toolIntent.args
      );
      const conversation = state.conversations.find((item) => item.id === approval.conversationId);
      if (conversation) {
        conversation.budgetUsed += approval.toolIntent.estimatedCost;
        conversation.messages.push(message("tool", `${approval.toolIntent.toolId}\n${stringifyToolResult(result)}`));
      }
      addLog({
        actor: "agent",
        conversationId: approval.conversationId,
        event: "tool_result",
        message: `${approval.toolIntent.toolId} executed after human approval.`,
        serverId: approval.toolIntent.serverId,
        toolName: approval.toolIntent.toolName,
        metadata: { result: stringifyToolResult(result).slice(0, 2000) }
      });
    } catch (error) {
      addLog({
        actor: "system",
        conversationId: approval.conversationId,
        event: "tool_error",
        message: "Approved tool failed safely during execution.",
        serverId: approval.toolIntent.serverId,
        toolName: approval.toolIntent.toolName,
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  broadcast("approval");
  return approval;
}

function buildAnswer(userMessage: string, conversation: Conversation, results: Array<{ toolId: string; result: string }>) {
  const blocked = conversation.messages.filter((item) => item.role === "system" && item.content.startsWith("Blocked"));
  const approvals = conversation.messages.filter((item) => item.role === "system" && item.content.includes("Approval queued"));

  if (results.length === 0 && blocked.length > 0) {
    return `I captured the intent, but did not execute the unsafe action. ${blocked.at(-1)?.content}`;
  }

  const summary = results
    .map((item) => `From ${item.toolId}: ${item.result.slice(0, 700)}`)
    .join("\n\n");

  const approvalNote = approvals.length > 0 ? `\n\n${approvals.length} action is waiting for human approval in the dashboard.` : "";
  return [
    `Intent captured: ${conversation.declaredIntent}.`,
    results.length ? `Policy allowed ${results.length} MCP call(s), and the result is:\n\n${summary}` : "No tool execution was needed.",
    blocked.length ? `${blocked.length} proposed action(s) were blocked before execution.` : "",
    approvalNote,
    `Original request: ${userMessage}`
  ]
    .filter(Boolean)
    .join("\n\n");
}
