import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  AuditLog,
  Conversation,
  DiscoveredTool,
  GuardrailRule,
  McpServerConfig
} from "../../../../packages/shared/src/types";

export interface AppState {
  rules: GuardrailRule[];
  servers: McpServerConfig[];
  tools: DiscoveredTool[];
  logs: AuditLog[];
  approvals: ApprovalRequest[];
  conversations: Conversation[];
}

export const state: AppState = {
  rules: [
    {
      id: "rule-block-delete",
      name: "Block destructive tools",
      description: "Never let the agent execute delete-style tools.",
      type: "block_tool",
      enabled: true,
      priority: 100,
      severity: "critical",
      toolPattern: "*.delete_*"
    },
    {
      id: "rule-approval-writes",
      name: "Human approval for writes",
      description: "Writes can change state, so queue them for admin review.",
      type: "require_approval",
      enabled: true,
      priority: 80,
      severity: "medium",
      toolPattern: "*.write_*"
    },
    {
      id: "rule-sandbox-paths",
      name: "Sandbox path boundary",
      description: "Any file path argument must remain under /sandbox.",
      type: "path_allowlist",
      enabled: true,
      priority: 90,
      severity: "high",
      toolPattern: "sandbox.*",
      pathPrefix: "/sandbox"
    },
    {
      id: "rule-budget",
      name: "Conversation budget",
      description: "Stop tool use once the conversation crosses the cost budget.",
      type: "budget_limit",
      enabled: true,
      priority: 70,
      severity: "medium",
      budgetLimit: 12
    },
    {
      id: "rule-injection",
      name: "Prompt injection tripwire",
      description: "Block attempts to bypass policy or reveal hidden instructions.",
      type: "prompt_injection",
      enabled: true,
      priority: 95,
      severity: "critical",
      injectionPatterns: [
        "ignore previous instructions",
        "ignore all policies",
        "bypass guardrails",
        "disable policy",
        "reveal system prompt",
        "act as unrestricted"
      ]
    }
  ],
  servers: [
    {
      id: "sandbox",
      name: "Custom Sandbox MCP",
      kind: "custom",
      command: "npx",
      args: ["tsx", "apps/custom-mcp-server/src/server.ts"],
      env: {
        SANDBOX_ROOT: "data/sandbox"
      },
      enabled: true
    },
    {
      id: "context7",
      name: "Context7 Remote MCP",
      kind: "remote",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: process.env.ENABLE_REMOTE_CONTEXT7 !== "false"
    }
  ],
  tools: [],
  logs: [],
  approvals: [],
  conversations: []
};

export function addLog(log: Omit<AuditLog, "id" | "timestamp">): AuditLog {
  const entry: AuditLog = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...log
  };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 300);
  return entry;
}

export function snapshot() {
  return {
    rules: state.rules,
    servers: state.servers,
    tools: state.tools,
    logs: state.logs,
    approvals: state.approvals,
    conversations: state.conversations
  };
}
