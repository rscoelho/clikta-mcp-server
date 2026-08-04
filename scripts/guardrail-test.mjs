// Manual verification of the Fase 3 guardrails (not the happy-path pipeline —
// see e2e-test.mjs for that): the destructive-click block/confirm flow, and
// the non-sandbox toolUrl warning.
//
// Usage:
//   CLIKTA_API_URL=http://localhost:3000 CLIKTA_API_TOKEN=clikta_... \
//     node scripts/guardrail-test.mjs
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
  env: { ...process.env, CLIKTA_API_URL: API_URL, CLIKTA_API_TOKEN: API_TOKEN, CLIKTA_MCP_HEADLESS: "true" },
});
const client = new Client({ name: "clikta-mcp-guardrail-test", version: "0.0.1" });

function unwrap(result) {
  const text = result?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.log(`FAIL: ${label}`);
    failed++;
  }
}

const DELETE_PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<button id='delete'>Delete Account</button><button id='cancel'>Cancel</button>"
  );

async function main() {
  await client.connect(transport);

  // 1. toolUrl warning: non-sandbox host should warn, localhost should not.
  const started = unwrap(await client.callTool({
    name: "clikta_start_recording",
    arguments: { name: "[guardrail-test] warnings", toolUrl: "https://example.com" },
  }));
  check("non-sandbox toolUrl (example.com) returns a warning", typeof started.warning === "string");
  await client.callTool({ name: "clikta_finish_recording", arguments: {} });

  const startedLocal = unwrap(await client.callTool({
    name: "clikta_start_recording",
    arguments: { name: "[guardrail-test] no warning", toolUrl: `${API_URL}/login` },
  }));
  check("localhost toolUrl has no warning", startedLocal.warning === undefined);

  // 2. destructive click block/confirm, against the started (localhost) recording.
  await client.callTool({ name: "clikta_navigate", arguments: { url: DELETE_PAGE } });

  const blocked = await client.callTool({
    name: "clikta_click",
    arguments: { text: "Delete Account" },
  });
  const blockedBody = unwrap(blocked);
  check(
    "click on 'Delete Account' without confirm is blocked",
    blocked.isError === true && /destructive|confirm/i.test(String(blockedBody))
  );

  const confirmed = await client.callTool({
    name: "clikta_click",
    arguments: { text: "Delete Account", confirm: true },
  });
  const confirmedBody = unwrap(confirmed);
  check("click on 'Delete Account' with confirm:true succeeds", confirmed.isError !== true && confirmedBody.ok === true);

  // Non-destructive click should never require confirm.
  const cancelClick = await client.callTool({
    name: "clikta_click",
    arguments: { text: "Cancel" },
  });
  check("click on non-destructive 'Cancel' works without confirm", cancelClick.isError !== true);

  await client.callTool({ name: "clikta_finish_recording", arguments: {} });
  await client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Guardrail test crashed:", err);
  process.exit(1);
});
