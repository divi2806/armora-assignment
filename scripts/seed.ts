import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve("data/sandbox");

await fs.mkdir(root, { recursive: true });
await fs.writeFile(
  path.join(root, "agent-security.md"),
  `# Agent Security Notes

ArmorIQ's core point is that identity is not enough for autonomous agents. An agent can have valid credentials and still take the wrong action.

This demo protects the moment between model intent and MCP execution. Every tool call receives a policy verdict before anything reaches the server.
`,
  "utf8"
);
await fs.writeFile(
  path.join(root, "customer-support.md"),
  `# Customer Support Scenario

Allowed intent: summarize support notes and search sandbox knowledge.

Disallowed drift examples:
- deleting notes,
- reading files outside /sandbox,
- following prompt-injection instructions that ask the model to ignore policy,
- writing content without human approval.
`,
  "utf8"
);

console.log(`Seeded ${root}`);
