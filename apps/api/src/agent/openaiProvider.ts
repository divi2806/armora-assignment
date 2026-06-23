import "dotenv/config";
import OpenAI from "openai";
import type { DiscoveredTool } from "../../../../packages/shared/src/types";

export interface PlannedToolCall {
  toolId: string;
  args: Record<string, unknown>;
  rationale: string;
}

export interface PlannerResult {
  declaredIntent: string;
  answer?: string;
  toolCalls: PlannedToolCall[];
  provider: "openai" | "demo";
}

function asFunctionName(toolId: string) {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, "__");
}

function fromFunctionName(functionName: string, tools: DiscoveredTool[]) {
  return tools.find((tool) => asFunctionName(tool.id) === functionName)?.id ?? functionName.replaceAll("__", ".");
}

export async function planWithOpenAI(params: {
  message: string;
  tools: DiscoveredTool[];
  previousToolResults?: Array<{ toolId: string; result: string }>;
}): Promise<PlannerResult> {
  if (!process.env.OPENAI_API_KEY) {
    return planWithDemoHeuristics(params.message, params.tools);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const toolDefs = params.tools.map((tool) => ({
    type: "function",
    name: asFunctionName(tool.id),
    description: `${tool.serverName}.${tool.name}: ${tool.description ?? "MCP tool"}`,
    parameters: tool.inputSchema
  }));

  const system = [
    "You are the planning brain for Intent Gate, an ArmorIQ-style guarded MCP agent.",
    "Declare the user's intent in one compact sentence.",
    "Use MCP tools only when useful.",
    "Never claim a tool executed unless the host gives you a tool result.",
    "Security policy is enforced by the host after you propose tool calls."
  ].join("\n");

  const input = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        params.message,
        "",
        "Return normal assistant text if no tool is needed. If a tool is needed, call one or more functions.",
        params.previousToolResults?.length
          ? `Previous tool results:\n${params.previousToolResults.map((item) => `${item.toolId}: ${item.result}`).join("\n")}`
          : ""
      ].join("\n")
    }
  ];

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    input,
    tools: toolDefs,
    tool_choice: "auto"
  } as never);

  const output = (response as unknown as { output?: Array<Record<string, unknown>>; output_text?: string }).output ?? [];
  const toolCalls: PlannedToolCall[] = [];

  for (const item of output) {
    if (item.type === "function_call") {
      const name = String(item.name ?? "");
      const argsText = String(item.arguments ?? "{}");
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsText) as Record<string, unknown>;
      } catch {
        args = {};
      }
      toolCalls.push({
        toolId: fromFunctionName(name, params.tools),
        args,
        rationale: "Model proposed MCP tool execution."
      });
    }
  }

  return {
    declaredIntent: `Respond to: ${params.message.slice(0, 120)}`,
    answer: (response as unknown as { output_text?: string }).output_text,
    toolCalls,
    provider: "openai"
  };
}

export async function synthesizeWithOpenAI(params: {
  message: string;
  declaredIntent: string;
  toolResults: Array<{ toolId: string; result: string }>;
  policyNotes: string[];
}): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          "You are the final response writer for Intent Gate, an ArmorIQ-style guarded MCP agent.",
          "Use only the tool results and policy notes provided by the host.",
          "Do not invent tool execution. If an action was blocked or queued, say that plainly."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `Original user request: ${params.message}`,
          `Declared intent: ${params.declaredIntent}`,
          "",
          "Policy notes:",
          params.policyNotes.length ? params.policyNotes.join("\n") : "No policy blocks or approvals.",
          "",
          "Tool results:",
          params.toolResults.length
            ? params.toolResults.map((item) => `${item.toolId}:\n${item.result}`).join("\n\n")
            : "No tools executed."
        ].join("\n")
      }
    ]
  } as never);

  return (response as unknown as { output_text?: string }).output_text ?? null;
}

export function planWithDemoHeuristics(message: string, tools: DiscoveredTool[]): PlannerResult {
  const lower = message.toLowerCase();
  const toolCalls: PlannedToolCall[] = [];

  const find = (name: string) => tools.find((tool) => tool.name === name);
  const rawPath = message.match(/\/sandbox\/[^\s)]+/)?.[0];
  const extractedPath = rawPath?.replace(/[,.!?;:]+$/, "");
  const path = extractedPath ?? "/sandbox/agent-security.md";

  if (lower.includes("delete")) {
    const tool = find("delete_note");
    if (tool) toolCalls.push({ toolId: tool.id, args: { path }, rationale: "User requested deletion." });
  } else if (lower.includes("write") || lower.includes("create note") || lower.includes("save")) {
    const tool = find("write_note");
    if (tool) {
      toolCalls.push({
        toolId: tool.id,
        args: {
          path: extractedPath ?? "/sandbox/generated-summary.md",
          content: `Generated by Intent Gate demo for request: ${message}`
        },
        rationale: "User requested a state-changing write."
      });
    }
  } else if (lower.includes("search") || lower.includes("find")) {
    const tool = find("search_notes");
    if (tool) {
      const query = lower.includes("armoriq") ? "ArmorIQ" : lower.includes("intent") ? "intent" : "policy";
      toolCalls.push({ toolId: tool.id, args: { query, directory: "/sandbox" }, rationale: "Search local sandbox notes." });
    }
  } else if (lower.includes("outside") || lower.includes("/etc/passwd")) {
    const tool = find("read_note");
    if (tool) toolCalls.push({ toolId: tool.id, args: { path: "/etc/passwd" }, rationale: "Demonstrate path boundary." });
  } else {
    const list = find("list_notes");
    const read = find("read_note");
    if (list) toolCalls.push({ toolId: list.id, args: { directory: "/sandbox" }, rationale: "Inspect available sandbox notes." });
    if (read) toolCalls.push({ toolId: read.id, args: { path }, rationale: "Read relevant sandbox note." });
  }

  return {
    declaredIntent: lower.includes("delete")
      ? "Attempt destructive sandbox operation"
      : lower.includes("write") || lower.includes("save")
        ? "Create or modify sandbox notes"
        : "Read and summarize sandbox knowledge",
    toolCalls,
    provider: "demo"
  };
}
