export type PolicyVerdict = "allow" | "block" | "approval_required";

export type RuleType =
  | "block_tool"
  | "require_approval"
  | "path_allowlist"
  | "budget_limit"
  | "prompt_injection";

export type RuleSeverity = "low" | "medium" | "high" | "critical";

export interface GuardrailRule {
  id: string;
  name: string;
  description: string;
  type: RuleType;
  enabled: boolean;
  priority: number;
  severity: RuleSeverity;
  toolPattern?: string;
  pathPrefix?: string;
  budgetLimit?: number;
  injectionPatterns?: string[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  kind: "custom" | "remote";
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface DiscoveredTool {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  status: "available" | "unavailable";
}

export interface ToolIntent {
  conversationId: string;
  userMessage: string;
  declaredIntent: string;
  serverId: string;
  toolName: string;
  toolId: string;
  args: Record<string, unknown>;
  estimatedCost: number;
}

export interface PolicyDecision {
  verdict: PolicyVerdict;
  reason: string;
  matchedRuleIds: string[];
  severity: RuleSeverity;
  requiresApprovalId?: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  conversationId: string;
  actor: "agent" | "admin" | "system";
  event:
    | "conversation_started"
    | "tool_discovered"
    | "tool_intent"
    | "policy_allow"
    | "policy_block"
    | "approval_requested"
    | "approval_resolved"
    | "tool_result"
    | "tool_error"
    | "server_error"
    | "rule_updated"
    | "budget_exceeded";
  message: string;
  serverId?: string;
  toolName?: string;
  verdict?: PolicyVerdict;
  ruleIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  conversationId: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  toolIntent: ToolIntent;
  decision: PolicyDecision;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionReason?: string;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  declaredIntent: string;
  budgetUsed: number;
  messages: ConversationMessage[];
}

export interface AgentRunResult {
  conversation: Conversation;
  answer: string;
  toolEvents: AuditLog[];
}
