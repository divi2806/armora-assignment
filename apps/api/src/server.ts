import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, resolveApproval } from "./agent/agent";
import { mcpRegistry } from "./mcp/registry";
import { addEventClient, broadcast } from "./store/events";
import { addLog, snapshot, state } from "./store/state";

const app = express();
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxRoot = path.resolve(process.cwd(), process.env.SANDBOX_ROOT ?? "data/sandbox");
const seededSandboxFiles = new Map([
  [
    "agent-security.md",
    `# Agent Security Notes

ArmorIQ's core point is that identity is not enough for autonomous agents. An agent can have valid credentials and still take the wrong action.

This demo protects the moment between model intent and MCP execution. Every tool call receives a policy verdict before anything reaches the server.
`
  ],
  [
    "customer-support.md",
    `# Customer Support Scenario

Allowed intent: summarize support notes and search sandbox knowledge.

Disallowed drift examples:
- deleting notes,
- reading files outside /sandbox,
- following prompt-injection instructions that ask the model to ignore policy,
- writing content without human approval.
`
  ]
]);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    time: new Date().toISOString()
  });
});

app.get("/api/state", (_req, res) => {
  res.json(snapshot());
});

app.post("/api/demo/reset", async (_req, res) => {
  try {
    await fs.mkdir(sandboxRoot, { recursive: true });
    const entries = await fs.readdir(sandboxRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && !seededSandboxFiles.has(entry.name))
        .map((entry) => fs.rm(path.join(sandboxRoot, entry.name), { force: true }))
    );
    await Promise.all(
      [...seededSandboxFiles.entries()].map(([filename, contents]) =>
        fs.writeFile(path.join(sandboxRoot, filename), contents, "utf8")
      )
    );

    state.logs = [];
    state.approvals = [];
    state.conversations = [];
    broadcast("agent");
    res.json(snapshot());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  addEventClient(res);
});

app.post("/api/agent/run", async (req, res) => {
  try {
    const body = req.body as { message?: string; conversationId?: string };
    if (!body.message?.trim()) {
      res.status(400).json({ error: "Message is required." });
      return;
    }
    const result = await runAgent(body.message.trim(), body.conversationId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/registry/refresh", async (_req, res) => {
  await mcpRegistry.refresh();
  res.json({ tools: state.tools });
});

app.patch("/api/rules/:id", (req, res) => {
  const rule = state.rules.find((item) => item.id === req.params.id);
  if (!rule) {
    res.status(404).json({ error: "Rule not found." });
    return;
  }
  Object.assign(rule, req.body);
  addLog({
    actor: "admin",
    conversationId: "dashboard",
    event: "rule_updated",
    message: `Rule updated: ${rule.name}`,
    ruleIds: [rule.id],
    metadata: { rule }
  });
  broadcast("rules");
  res.json(rule);
});

app.post("/api/rules", (req, res) => {
  const rule = {
    id: `rule-${Date.now()}`,
    name: "New guardrail",
    description: "Custom dashboard rule.",
    type: "block_tool" as const,
    enabled: true,
    severity: "medium" as const,
    toolPattern: "*",
    ...req.body,
    priority: Number((req.body as { priority?: unknown }).priority ?? 40),
    budgetLimit:
      (req.body as { budgetLimit?: unknown }).budgetLimit === undefined
        ? undefined
        : Number((req.body as { budgetLimit?: unknown }).budgetLimit)
  };
  state.rules.unshift(rule);
  addLog({
    actor: "admin",
    conversationId: "dashboard",
    event: "rule_updated",
    message: `Rule created: ${rule.name}`,
    ruleIds: [rule.id]
  });
  broadcast("rules");
  res.status(201).json(rule);
});

app.post("/api/approvals/:id/resolve", async (req, res) => {
  try {
    const body = req.body as { approved?: boolean; reason?: string };
    const approval = await resolveApproval(req.params.id, Boolean(body.approved), body.reason ?? "Resolved in dashboard.");
    res.json(approval);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/servers/:id/toggle", async (req, res) => {
  const server = state.servers.find((item) => item.id === req.params.id);
  if (!server) {
    res.status(404).json({ error: "Server not found." });
    return;
  }
  server.enabled = Boolean((req.body as { enabled?: boolean }).enabled);
  await mcpRegistry.closeAll();
  await mcpRegistry.refresh();
  res.json(server);
});

const staticDir = path.resolve(__dirname, "../../../dist/web");
app.use(express.static(staticDir));
app.use((_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.listen(port, async () => {
  console.log(`Intent Gate API listening on http://localhost:${port}`);
  await mcpRegistry.refresh();
});

process.on("SIGINT", async () => {
  await mcpRegistry.closeAll();
  process.exit(0);
});
