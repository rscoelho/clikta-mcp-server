// Manual end-to-end smoke test: spawns the built MCP server over stdio,
// drives it through a small recording via the real MCP client protocol
// (not a shortcut import of the tool functions), and prints the result.
//
// Usage:
//   CLIKTA_API_URL=http://localhost:3000 CLIKTA_API_TOKEN=clikta_... \
//     node scripts/e2e-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "..", "dist", "index.js");

const API_URL = process.env.CLIKTA_API_URL || "http://localhost:3000";
const API_TOKEN = process.env.CLIKTA_API_TOKEN;
if (!API_TOKEN) {
  console.error("Set CLIKTA_API_TOKEN before running this script.");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  env: {
    ...process.env,
    CLIKTA_API_URL: API_URL,
    CLIKTA_API_TOKEN: API_TOKEN,
    CLIKTA_MCP_HEADLESS: "true",
  },
});

const client = new Client({ name: "clikta-mcp-e2e-test", version: "0.0.1" });

function unwrap(result) {
  const text = result?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const parsed = unwrap(result);
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(parsed, null, 2));
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function main() {
  await client.connect(transport);

  await call("clikta_start_recording", {
    name: "[e2e-test] Login page walkthrough",
    objective: "Show how to fill in the login form",
    toolUrl: `${API_URL}/login`,
  });

  await call("clikta_note", {
    text: "First, click into the email field to start signing in.",
  });
  await call("clikta_click", { selector: 'input[type="email"]' });
  await call("clikta_type", { selector: 'input[type="email"]', value: "demo@example.com" });

  await call("clikta_note", {
    text: "Then enter the account password.",
  });
  await call("clikta_click", { selector: 'input[type="password"]' });
  await call("clikta_type", { selector: 'input[type="password"]', value: "hunter2-example" });

  const finished = await call("clikta_finish_recording", {});

  console.log("\n=== DONE ===");
  console.log(`Share URL: ${finished.shareUrl}`);

  await client.close();
}

main().catch((err) => {
  console.error("\nE2E test FAILED:", err);
  process.exit(1);
});
