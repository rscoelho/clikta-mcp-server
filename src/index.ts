#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser } from "./browser.js";
import { registerTools } from "./tools.js";
import { CLIKTA_MCP_INSTRUCTIONS } from "./instructions.js";

const server = new McpServer({ name: "clikta", version: "0.2.0" }, { instructions: CLIKTA_MCP_INSTRUCTIONS });
registerTools(server);

async function shutdown() {
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
