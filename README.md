# @clikta/mcp-server

MCP server that lets Claude drive a real browser and turn what it does into a Clikta interactive demo, step-by-step guide, and narrated video — automatically. No manual clicking, no Chrome extension required.

It reuses the exact same pipeline as the Clikta Chrome extension: every action is posted as an `Event` to your Clikta workspace, and `clikta_finish_recording` triggers the same AI guide generator that turns a human's recording into steps.

Built by [Clikta](https://clikta.com) — the design rationale and implementation history live in `docs/mcp-architecture.md` in the [main `clikta` repo](https://github.com/rscoelho/clikta).

## Setup

1. Get an API token: in the Clikta web app, go to **Settings → API Token** and generate one (`clikta_...`). This is the same token type the Chrome extension uses.
2. Install Playwright's Chromium browser (runs automatically on `npm install` via `postinstall`, but you can re-run it manually):
   ```bash
   npx playwright install chromium
   ```
3. Add the server to Claude Code (or any MCP host) — either via the CLI:
   ```bash
   claude mcp add clikta -- npx -y @clikta/mcp-server
   ```
   or by adding it to your `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "clikta": {
         "command": "npx",
         "args": ["-y", "@clikta/mcp-server"],
         "env": {
           "CLIKTA_API_URL": "https://clikta.com",
           "CLIKTA_API_TOKEN": "clikta_..."
         }
       }
     }
   }
   ```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CLIKTA_API_TOKEN` | yes | — | Generated in Settings → API Token |
| `CLIKTA_API_URL` | no | `https://clikta.com` | Point at a self-hosted instance if you run one |
| `CLIKTA_MCP_HEADLESS` | no | `false` | Set `"true"` to run Chromium headless (CI/scripted use). Headed by default so you can watch the demo happen live |

## Tools

| Tool | What it does |
|---|---|
| `clikta_start_recording` | Creates a recording, launches the browser, optionally navigates to `toolUrl` |
| `clikta_navigate` | Go to a URL, logs a `navigate` step |
| `clikta_click` | Click an element (by role/name, text, or CSS selector), logs a `click` step. Refuses destructive-looking targets (delete/pay/confirm purchase/...) unless `confirm: true` |
| `clikta_type` | Fill a field, logs an `input` step |
| `clikta_note` | Explain *why* you did something — feeds the AI guide generator the same way a human's spoken narration does. Use this liberally, it's the highest-leverage tool here |
| `clikta_screenshot` | Ad-hoc screenshot saved to the Clikta screenshot library |
| `clikta_finish_recording` | Marks the recording done, generates the AI guide, publishes it, returns the share link, closes the browser |
| `clikta_list_recordings` | Lists existing recordings, to resume or avoid duplicates |
| `clikta_list_tools` | Lists registered Clikta "Tool" entities (products), to attach a recording to an existing one via `toolId` |

## Typical flow

1. `clikta_start_recording` with a `name` and `toolUrl` pointing at the product/page to demo
2. Open the returned `watchUrl` in a browser to watch steps land live
3. `clikta_navigate` / `clikta_click` / `clikta_type` through the flow, calling `clikta_note` to explain intent along the way
4. `clikta_finish_recording` to generate and publish the guide

## Guardrails

- Never click through payments, deletions, or other irreversible actions without the user's explicit go-ahead — `clikta_click` blocks these by default (see `src/locator.ts`'s destructive-label patterns) and requires `confirm: true` to proceed.
- `clikta_start_recording` warns (non-blocking, via a `warning` field in its result) when `toolUrl`'s host doesn't look like a staging/sandbox environment — prefer pointing it at one when available.
- API calls retry transient failures (network errors, 408/409/429/5xx) up to 3 times with backoff; real client errors (401/404/400/...) fail immediately since retrying won't help.
- Screenshots may capture whatever is on the page, including sensitive data — same disclosure as the [Chrome extension's privacy policy](https://clikta.com/privacy) applies here.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm run dev      # tsc --watch
```

### Manual test scripts

Both spawn the built server and drive it through the real MCP client protocol (`@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`), not a shortcut import of the tool functions. Need a real Clikta instance and an API token — generate one from **Settings → API Token** in the Clikta web app (or, if you also have the [main `clikta` repo](https://github.com/rscoelho/clikta) checked out, `node scripts/mint-api-token.mjs you@example.com` there mints one directly against the dev DB without going through the login UI).

```bash
CLIKTA_API_URL=http://localhost:3000 CLIKTA_API_TOKEN=clikta_... node scripts/e2e-test.mjs        # happy-path pipeline
CLIKTA_API_URL=http://localhost:3000 CLIKTA_API_TOKEN=clikta_... node scripts/guardrail-test.mjs   # destructive-click block + sandbox warning
```
