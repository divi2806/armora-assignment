import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.SANDBOX_ROOT ?? "data/sandbox");

function insideSandbox(target: string): string {
  const resolved = path.resolve(root, target.replace(/^\/sandbox\/?/, ""));
  if (!resolved.startsWith(root)) {
    throw new Error("Path escapes sandbox root.");
  }
  return resolved;
}

async function ensureRoot() {
  await fs.mkdir(root, { recursive: true });
}

function text(content: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof content === "string" ? content : JSON.stringify(content, null, 2)
      }
    ]
  };
}

const server = new McpServer({
  name: "intent-gate-sandbox",
  version: "1.0.0"
});

server.registerTool(
  "list_notes",
  {
    title: "List sandbox notes",
    description: "List note files under the sandbox root.",
    inputSchema: {
      directory: z.string().default("/sandbox")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ directory }) => {
    await ensureRoot();
    const dir = insideSandbox(directory);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return text(
      entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        path: `/sandbox/${path.relative(root, path.join(dir, entry.name)).replaceAll(path.sep, "/")}`
      }))
    );
  }
);

server.registerTool(
  "read_note",
  {
    title: "Read sandbox note",
    description: "Read a text note from the sandbox root.",
    inputSchema: {
      path: z.string().describe("Path beginning with /sandbox/")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ path: notePath }) => {
    const file = insideSandbox(notePath);
    const content = await fs.readFile(file, "utf8");
    return text(content);
  }
);

server.registerTool(
  "write_note",
  {
    title: "Write sandbox note",
    description: "Create or replace a text note in the sandbox root.",
    inputSchema: {
      path: z.string().describe("Path beginning with /sandbox/"),
      content: z.string().max(8000)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ path: notePath, content }) => {
    const file = insideSandbox(notePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return text({ ok: true, path: notePath, bytes: Buffer.byteLength(content) });
  }
);

server.registerTool(
  "search_notes",
  {
    title: "Search sandbox notes",
    description: "Search text notes under the sandbox root.",
    inputSchema: {
      query: z.string().min(1),
      directory: z.string().default("/sandbox")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ query, directory }) => {
    await ensureRoot();
    const dir = insideSandbox(directory);
    const terms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 2);
    const matches: Array<{ path: string; line: number; preview: string; score: number }> = [];

    async function walk(current: string) {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const body = await fs.readFile(full, "utf8");
        body.split(/\r?\n/).forEach((line, index) => {
          const normalized = line.toLowerCase();
          const exact = normalized.includes(query.toLowerCase());
          const score = exact ? terms.length + 2 : terms.filter((term) => normalized.includes(term)).length;
          if (score > 0) {
            matches.push({
              path: `/sandbox/${path.relative(root, full).replaceAll(path.sep, "/")}`,
              line: index + 1,
              preview: line.slice(0, 220),
              score
            });
          }
        });
      }
    }

    await walk(dir);
    return text(matches.sort((a, b) => b.score - a.score).slice(0, 12));
  }
);

server.registerTool(
  "delete_note",
  {
    title: "Delete sandbox note",
    description: "Delete a note from the sandbox root. This is intentionally destructive for policy demos.",
    inputSchema: {
      path: z.string().describe("Path beginning with /sandbox/")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ path: notePath }) => {
    const file = insideSandbox(notePath);
    await fs.unlink(file);
    return text({ ok: true, deleted: notePath });
  }
);

await ensureRoot();
await server.connect(new StdioServerTransport());
