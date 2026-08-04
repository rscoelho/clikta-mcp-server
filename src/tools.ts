import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_URL } from "./config.js";
import { clicktaApi } from "./client.js";
import { closeBrowser, getPage, screenshotJpegBase64 } from "./browser.js";
import { describeElement, isDestructiveLabel, looksLikeSandbox, resolveLocator } from "./locator.js";
import { recordingSession, requireActiveRecording, resetRecordingSession } from "./session.js";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// MCP hosts don't always render a thrown exception nicely — catch every
// handler and turn it into an explicit tool error result instead.
function safe<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

const targetShape = {
  role: z.string().optional().describe("ARIA role, e.g. 'button', 'link', 'textbox'. Best paired with `name`."),
  name: z.string().optional().describe("Accessible name to match, used together with `role`."),
  text: z.string().optional().describe("Visible text to match, when the role isn't known."),
  selector: z.string().optional().describe("Raw CSS selector, as a last resort."),
};

export function registerTools(server: McpServer): void {
  server.tool(
    "clikta_start_recording",
    "Start a new Clikta recording. Creates the recording on the Clikta workspace, launches a real browser, " +
      "and (if toolUrl is given) navigates there first. Call this before any other clikta_* action tool. " +
      "Prefer a staging/sandbox toolUrl over production when one is available — the result includes a warning " +
      "if the URL doesn't look like one.",
    {
      name: z.string().min(1).describe("Name for the recording/demo, e.g. 'Sign up flow'"),
      objective: z.string().optional().describe("What this demo should show or teach"),
      toolId: z
        .string()
        .optional()
        .describe("Existing Clikta Tool id (from clikta_list_tools) to attach this recording to"),
      toolUrl: z.string().url().optional().describe("URL to open first — the product/page being demoed"),
    },
    safe(async ({ name, objective, toolId, toolUrl }) => {
      const recording = await clicktaApi.createRecording({ name, objective, toolId });
      recordingSession.recordingId = recording.id;
      recordingSession.eventCount = 0;

      const page = await getPage();
      if (toolUrl) {
        await page.goto(toolUrl, { waitUntil: "domcontentloaded" });
        const viewport = page.viewportSize();
        await clicktaApi.postEvent(recording.id, {
          type: "navigate",
          url: page.url(),
          pageTitle: await page.title(),
          viewportWidth: viewport?.width ?? null,
          viewportHeight: viewport?.height ?? null,
          screenshot: await screenshotJpegBase64(page),
        });
        recordingSession.eventCount++;
      }

      const watchUrl = `${API_URL}/recordings/${recording.id}`;
      const warning =
        toolUrl && !looksLikeSandbox(new URL(toolUrl).hostname)
          ? `${new URL(toolUrl).hostname} doesn't look like a staging/sandbox environment — you may be about ` +
            `to interact with a production system. Make sure the user is fine with real actions happening there ` +
            `before clicking anything that changes data.`
          : undefined;

      return textResult({
        recordingId: recording.id,
        watchUrl,
        ...(warning && { warning }),
        message: `Recording started. Open ${watchUrl} to watch steps appear live while you work.`,
      });
    })
  );

  server.tool(
    "clikta_navigate",
    "Navigate the active recording's browser to a URL and log it as a step.",
    { url: z.string().url() },
    safe(async ({ url }) => {
      const recordingId = requireActiveRecording();
      const page = await getPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const viewport = page.viewportSize();
      const event = await clicktaApi.postEvent(recordingId, {
        type: "navigate",
        url: page.url(),
        pageTitle: await page.title(),
        viewportWidth: viewport?.width ?? null,
        viewportHeight: viewport?.height ?? null,
        screenshot: await screenshotJpegBase64(page),
      });
      recordingSession.eventCount++;
      return textResult({ ok: true, eventOrder: event.order, url: page.url() });
    })
  );

  server.tool(
    "clikta_click",
    "Click an element in the active recording's browser and log it as a step. Locate the element with " +
      "role(+name), text, or selector — role/text are more resilient than raw CSS. Refuses to click elements " +
      "that look destructive (delete, payment, purchase confirmation, unsubscribe, ...) unless confirm:true.",
    {
      ...targetShape,
      confirm: z
        .boolean()
        .optional()
        .describe("Set true to proceed when the target looks like a destructive/irreversible action"),
    },
    safe(async ({ role, name, text, selector, confirm }) => {
      const recordingId = requireActiveRecording();
      const page = await getPage();
      const target = resolveLocator(page, { role, name, text, selector }).first();
      await target.waitFor({ state: "visible", timeout: 10_000 });

      const desc = await describeElement(target);
      if (isDestructiveLabel(desc.label) && !confirm) {
        throw new Error(
          `Refusing to click "${desc.label}" without confirmation — it looks like a destructive/irreversible ` +
            `action (delete, payment, purchase confirmation, etc.). Re-call clikta_click with confirm: true if ` +
            `this is intentional and the user has agreed to it.`
        );
      }

      const box = await target.boundingBox();
      await target.click();
      await page.waitForTimeout(300); // let navigation/UI settle before the screenshot
      const viewport = page.viewportSize();

      const event = await clicktaApi.postEvent(recordingId, {
        type: "click",
        url: page.url(),
        pageTitle: await page.title(),
        elementTag: desc.tag,
        elementLabel: desc.label,
        elementSelector: desc.selector,
        clickX: box ? box.x + box.width / 2 : null,
        clickY: box ? box.y + box.height / 2 : null,
        viewportWidth: viewport?.width ?? null,
        viewportHeight: viewport?.height ?? null,
        screenshot: await screenshotJpegBase64(page),
      });
      recordingSession.eventCount++;
      return textResult({ ok: true, clicked: desc.label, eventOrder: event.order });
    })
  );

  server.tool(
    "clikta_type",
    "Fill a text field in the active recording's browser and log it as a step.",
    { ...targetShape, value: z.string().describe("Text to type into the field") },
    safe(async ({ role, name, text, selector, value }) => {
      const recordingId = requireActiveRecording();
      const page = await getPage();
      const target = resolveLocator(page, { role, name, text, selector }).first();
      await target.waitFor({ state: "visible", timeout: 10_000 });

      const desc = await describeElement(target);
      await target.fill(value);
      const box = await target.boundingBox();
      const viewport = page.viewportSize();

      const event = await clicktaApi.postEvent(recordingId, {
        type: "input",
        url: page.url(),
        pageTitle: await page.title(),
        elementTag: desc.tag,
        elementLabel: desc.label,
        elementSelector: desc.selector,
        inputValue: value,
        clickX: box ? box.x + box.width / 2 : null,
        clickY: box ? box.y + box.height / 2 : null,
        viewportWidth: viewport?.width ?? null,
        viewportHeight: viewport?.height ?? null,
        screenshot: await screenshotJpegBase64(page),
      });
      recordingSession.eventCount++;
      return textResult({ ok: true, filled: desc.label, eventOrder: event.order });
    })
  );

  server.tool(
    "clikta_note",
    "Explain, in your own words, why you just did (or are about to do) something. This is the single most " +
      "valuable tool here: notes feed the same mechanism as a human's spoken narration, and Clikta's AI guide " +
      "generator uses them as context for writing each step's description. Call it liberally.",
    { text: z.string().min(1) },
    safe(async ({ text }) => {
      const recordingId = requireActiveRecording();
      await clicktaApi.postTranscript(recordingId, text);
      return textResult({ ok: true });
    })
  );

  server.tool(
    "clikta_screenshot",
    "Take an ad-hoc screenshot of the current page and save it to the Clikta screenshot library " +
      "(not tied to a recording step).",
    { title: z.string().optional() },
    safe(async ({ title }) => {
      const page = await getPage();
      const viewport = page.viewportSize();
      const pageTitle = await page.title();
      const saved = await clicktaApi.postScreenshot({
        image: await screenshotJpegBase64(page),
        title: title || pageTitle || "Untitled screenshot",
        url: page.url(),
        pageTitle,
        viewportWidth: viewport?.width,
        viewportHeight: viewport?.height,
      });
      return textResult({ ok: true, screenshotId: saved.id });
    })
  );

  server.tool(
    "clikta_finish_recording",
    "Stop the active recording, generate the AI guide/demo from the captured steps, publish it, and return " +
      "the shareable link. Closes the browser.",
    {},
    safe(async () => {
      const recordingId = requireActiveRecording();
      await clicktaApi.patchRecording(recordingId, { status: "done" });
      const generated = await clicktaApi.generateRecording(recordingId);
      const published = await clicktaApi.publishRecording(recordingId);
      await closeBrowser();
      resetRecordingSession();
      return textResult({
        ok: true,
        title: generated.title,
        stepsCount: generated.stepsCount,
        shareUrl: `${API_URL}${published.url}`,
      });
    })
  );

  server.tool(
    "clikta_list_recordings",
    "List existing recordings in the Clikta workspace, so you can resume or avoid duplicating work.",
    {},
    safe(async () => {
      const recordings = await clicktaApi.listRecordings();
      return textResult(recordings.map((r) => ({ id: r.id, name: r.name, status: r.status, published: r.published })));
    })
  );

  server.tool(
    "clikta_list_tools",
    "List the products/tools already registered in the Clikta workspace (Clikta 'Tool' entities, e.g. " +
      "'Acme Dashboard'), so a new recording can be attached to an existing one via toolId instead of creating " +
      "a duplicate.",
    {},
    safe(async () => {
      const tools = await clicktaApi.listTools();
      return textResult(tools);
    })
  );
}
