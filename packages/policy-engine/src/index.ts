import type { GuardrailRule, PolicyDecision, RuleSeverity, ToolIntent } from "../../shared/src/types";

const severityRank: Record<RuleSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

function highestSeverity(current: RuleSeverity, next: RuleSeverity): RuleSeverity {
  return severityRank[next] > severityRank[current] ? next : current;
}

function matchesTool(pattern: string | undefined, toolId: string, toolName: string): boolean {
  if (!pattern || pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(toolId) || regex.test(toolName);
}

function collectPathArguments(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPathArguments);
  if (!value || typeof value !== "object") return [];

  const paths: string[] = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const looksLikePathKey = /(^path$|path$|directory|dir|file|filename)/i.test(key);
    if (looksLikePathKey && typeof nestedValue === "string") {
      paths.push(nestedValue);
      continue;
    }
    if (nestedValue && typeof nestedValue === "object") {
      paths.push(...collectPathArguments(nestedValue));
    }
  }
  return paths;
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/\/+/g, "/");
}

export function evaluatePolicy(params: {
  intent: ToolIntent;
  rules: GuardrailRule[];
  currentBudget: number;
}): PolicyDecision {
  const activeRules = params.rules
    .filter((rule) => rule.enabled)
    .sort((a, b) => b.priority - a.priority);

  const matchedBlockRules: GuardrailRule[] = [];
  const matchedApprovalRules: GuardrailRule[] = [];

  for (const rule of activeRules) {
    if (rule.type === "budget_limit") {
      const limit = rule.budgetLimit ?? Number.POSITIVE_INFINITY;
      if (params.currentBudget + params.intent.estimatedCost > limit) {
        matchedBlockRules.push(rule);
      }
      continue;
    }

    if (rule.type === "prompt_injection") {
      const patterns = rule.injectionPatterns ?? [];
      const haystack = `${params.intent.userMessage}\n${params.intent.declaredIntent}\n${JSON.stringify(params.intent.args)}`.toLowerCase();
      if (patterns.some((pattern) => haystack.includes(pattern.toLowerCase()))) {
        matchedBlockRules.push(rule);
      }
      continue;
    }

    if (!matchesTool(rule.toolPattern, params.intent.toolId, params.intent.toolName)) {
      continue;
    }

    if (rule.type === "block_tool") {
      matchedBlockRules.push(rule);
    }

    if (rule.type === "require_approval") {
      matchedApprovalRules.push(rule);
    }

    if (rule.type === "path_allowlist") {
      const prefix = normalizePath(rule.pathPrefix ?? "/sandbox");
      const paths = collectPathArguments(params.intent.args);
      const outsideScope = paths.some((candidate) => {
        const normalized = normalizePath(candidate);
        return normalized.includes("..") || !normalized.startsWith(prefix);
      });
      if (outsideScope) {
        matchedBlockRules.push(rule);
      }
    }
  }

  if (matchedBlockRules.length > 0) {
    const severity = matchedBlockRules.reduce<RuleSeverity>((acc, rule) => highestSeverity(acc, rule.severity), "low");
    return {
      verdict: "block",
      reason: `Blocked before execution by ${matchedBlockRules.map((rule) => rule.name).join(", ")}.`,
      matchedRuleIds: matchedBlockRules.map((rule) => rule.id),
      severity
    };
  }

  if (matchedApprovalRules.length > 0) {
    const severity = matchedApprovalRules.reduce<RuleSeverity>((acc, rule) => highestSeverity(acc, rule.severity), "low");
    return {
      verdict: "approval_required",
      reason: `Human approval required by ${matchedApprovalRules.map((rule) => rule.name).join(", ")}.`,
      matchedRuleIds: matchedApprovalRules.map((rule) => rule.id),
      severity
    };
  }

  return {
    verdict: "allow",
    reason: "Tool intent is within declared scope and active policy.",
    matchedRuleIds: [],
    severity: "low"
  };
}
