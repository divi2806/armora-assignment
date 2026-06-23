import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addLog, state } from "../store/state";
import { broadcast } from "../store/events";
import type { DiscoveredTool, McpServerConfig } from "../../../../packages/shared/src/types";

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
}

export class McpRegistry {
  private servers = new Map<string, ConnectedServer>();
  private starting = false;

  async refresh() {
    if (this.starting) return;
    this.starting = true;
    const discovered: DiscoveredTool[] = [];

    for (const config of state.servers) {
      if (!config.enabled) continue;
      try {
        const connected = await this.ensureConnected(config);
        const tools = await connected.client.listTools();
        for (const tool of tools.tools) {
          discovered.push({
            id: `${config.id}.${tool.name}`,
            serverId: config.id,
            serverName: config.name,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations as Record<string, unknown> | undefined,
            status: "available"
          });
          addLog({
            actor: "system",
            conversationId: "registry",
            event: "tool_discovered",
            message: `Discovered ${config.name}.${tool.name}`,
            serverId: config.id,
            toolName: tool.name
          });
        }
      } catch (error) {
        addLog({
          actor: "system",
          conversationId: "registry",
          event: "server_error",
          message: `${config.name} unavailable during discovery.`,
          serverId: config.id,
          metadata: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }

    state.tools = discovered;
    this.starting = false;
    broadcast("registry");
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>) {
    const config = state.servers.find((server) => server.id === serverId);
    if (!config) throw new Error(`Unknown MCP server: ${serverId}`);
    const connected = await this.ensureConnected(config);
    return connected.client.callTool({ name: toolName, arguments: args });
  }

  async closeAll() {
    for (const connected of this.servers.values()) {
      await connected.client.close();
    }
    this.servers.clear();
  }

  private async ensureConnected(config: McpServerConfig): Promise<ConnectedServer> {
    const existing = this.servers.get(config.id);
    if (existing) return existing;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(config.env ?? {})
      } as Record<string, string>,
      stderr: "pipe"
    });

    transport.onerror = (error) => {
      addLog({
        actor: "system",
        conversationId: "registry",
        event: "server_error",
        message: `${config.name} transport error.`,
        serverId: config.id,
        metadata: { error: error.message }
      });
      this.servers.delete(config.id);
      broadcast("registry");
    };

    transport.onclose = () => {
      addLog({
        actor: "system",
        conversationId: "registry",
        event: "server_error",
        message: `${config.name} MCP process closed.`,
        serverId: config.id
      });
      this.servers.delete(config.id);
      broadcast("registry");
    };

    const client = new Client({
      name: "intent-gate-agent",
      version: "1.0.0"
    });
    await client.connect(transport);

    const connected = { config, client, transport };
    this.servers.set(config.id, connected);
    return connected;
  }
}

export const mcpRegistry = new McpRegistry();
