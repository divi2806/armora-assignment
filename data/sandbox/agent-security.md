# Agent Security Notes

ArmorIQ's core point is that identity is not enough for autonomous agents. An agent can have valid credentials and still take the wrong action.

This demo protects the moment between model intent and MCP execution. Every tool call receives a policy verdict before anything reaches the server.
