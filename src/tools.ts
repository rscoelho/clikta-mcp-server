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
      "and (if toolUrl is given) navigates there first. Call this before any other clikta_* action tool. For " +
      "anything beyond a trivial 1-2 step demo, call clikta_describe_tool and clikta_plan_demo first — planning " +
      "before you start driving the browser produces a noticeably better result than improvising click-by-click. " +
      "Prefer a staging/sandbox toolUrl over production when one is available — the result includes a warning " +
      "if the URL doesn't look like one. If this recording fills a chapter from clikta_create_module, pass " +
      "moduleId + chapterId so the finished recording links into that slot automatically.",
    {
      name: z.string().min(1).describe("Name for the recording/demo, e.g. 'Sign up flow'"),
      objective: z.string().optional().describe("What this demo should show or teach"),
      toolId: z
        .string()
        .optional()
        .describe("Existing Clikta Tool id (from clikta_list_tools) to attach this recording to"),
      toolUrl: z.string().url().optional().describe("URL to open first — the product/page being demoed"),
      moduleId: z
        .string()
        .optional()
        .describe("When recording a planned module chapter (from clikta_create_module/clikta_get_module): that module's id"),
      chapterId: z
        .string()
        .optional()
        .describe("When recording a planned module chapter: that chapter's id — requires moduleId too"),
    },
    safe(async ({ name, objective, toolId, toolUrl, moduleId, chapterId }) => {
      const recording = await clicktaApi.createRecording({ name, objective, toolId });
      if (moduleId && chapterId) {
        await clicktaApi.linkChapterRecording(moduleId, chapterId, recording.id);
      }
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
        message: `Recording started${moduleId && chapterId ? " and linked to its planned chapter" : ""}. Open ` +
          `${watchUrl} to watch steps appear live while you work.`,
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
      "a duplicate. Call this first, before clikta_create_tool — if the product you're about to record isn't " +
      "in this list, create it; if it is, reuse its id.",
    {},
    safe(async () => {
      const tools = await clicktaApi.listTools();
      return textResult(tools);
    })
  );

  server.tool(
    "clikta_create_tool",
    "Register a new product/tool in the Clikta workspace. Every recording made for this product afterwards " +
      "should pass its id as toolId — that's what lets clikta_describe_tool and clikta_plan_demo find and " +
      "reuse what's already known about it instead of starting blind every time. Call clikta_list_tools first " +
      "to make sure it doesn't already exist — a duplicate splits the product's recordings/modules across two " +
      "unrelated entities.",
    {
      name: z.string().min(1).describe("Product name, e.g. 'Acme Dashboard'"),
      url: z.string().url().optional().describe("The product's URL — also used to auto-fetch a favicon as the tool's logo"),
    },
    safe(async ({ name, url }) => {
      const tool = await clicktaApi.createTool({ name, url });
      return textResult({
        toolId: tool.id,
        name: tool.name,
        url: tool.url,
        message: `Tool created. Pass toolId "${tool.id}" to clikta_start_recording (and clikta_describe_tool / ` +
          `clikta_plan_demo on future recordings for this product).`,
      });
    })
  );

  server.tool(
    "clikta_describe_tool",
    "Read-only 'software intelligence' summary of a Clikta Tool: its existing modules/chapters, its past " +
      "recordings (with their already-written steps), whether a saved login session is available, and which " +
      "pages of the product past recordings actually visited. Call this before clikta_plan_demo or " +
      "clikta_start_recording so you don't duplicate an existing demo and can reuse what's already known about " +
      "the product's navigation.",
    { toolId: z.string().min(1).describe("Tool id, from clikta_list_tools") },
    safe(async ({ toolId }) => {
      const intelligence = await clicktaApi.describeTool(toolId);
      return textResult(intelligence);
    })
  );

  server.tool(
    "clikta_plan_demo",
    "Turn a plain-language objective into a short, ordered outline (3-8 high-level steps) BEFORE recording " +
      "anything — pre-processing for the demo, not a literal click script (exact selectors only make sense once " +
      "you see the real page). Pass toolId when one exists so the plan accounts for pages and demos Clikta " +
      "already knows about (see clikta_describe_tool) instead of risking a duplicate. Uses one AI credit. " +
      "After this, call clikta_start_recording and use the plan as a loose checklist — deviate from it freely " +
      "once the real page doesn't match what was assumed, and call clikta_note to explain any such deviation.",
    {
      objective: z.string().min(1).describe("What this demo should show or teach"),
      toolId: z
        .string()
        .optional()
        .describe("Existing Clikta Tool id (from clikta_list_tools) — enriches the plan with what's already known"),
      toolUrl: z.string().url().optional().describe("The product's URL, when there's no toolId yet"),
    },
    safe(async ({ objective, toolId, toolUrl }) => {
      const plan = await clicktaApi.planDemo({ objective, toolId, toolUrl });
      return textResult(plan);
    })
  );

  server.tool(
    "clikta_plan_module",
    "Propose a MODULE — a set of 3-8 separate demos (one per chapter) — that together cover a broad goal " +
      "(e.g. 'document the whole admin onboarding experience'), BEFORE recording anything or creating the " +
      "module itself. This is a PROPOSAL ONLY, nothing is saved. CRITICAL: show this proposal to the user and " +
      "get their explicit go-ahead (or their edits) before calling clikta_create_module — do not persist a " +
      "module plan the user hasn't actually seen and approved. Skip this tool entirely for a single, " +
      "self-contained demo (use clikta_plan_demo instead). Uses one AI credit.",
    {
      objective: z.string().min(1).describe("The broad goal this module should cover"),
      toolId: z
        .string()
        .optional()
        .describe("Existing Clikta Tool id (from clikta_list_tools) — avoids proposing chapters that duplicate existing demos/modules"),
      toolUrl: z.string().url().optional().describe("The product's URL, when there's no toolId yet"),
    },
    safe(async ({ objective, toolId, toolUrl }) => {
      const plan = await clicktaApi.planModule({ objective, toolId, toolUrl });
      return textResult({
        ...plan,
        message:
          "This is a proposal, not yet saved. Show it to the user — confirm the module name/description and " +
          "the list of chapters (add/remove/reorder as they ask) — before calling clikta_create_module.",
      });
    })
  );

  server.tool(
    "clikta_create_module",
    "Persist a Module and its planned chapters, ONLY after the user has approved the proposal from " +
      "clikta_plan_module (or given you an equivalent plan directly). Each chapter is created as a 'demo' " +
      "chapter with no recording attached yet — record it later with clikta_start_recording, passing that " +
      "chapter's moduleId/chapterId so the finished recording links into its slot automatically.",
    {
      toolId: z.string().min(1).describe("Tool id this module belongs to (from clikta_list_tools / clikta_create_tool)"),
      name: z.string().min(1).describe("Module name, from the approved plan"),
      description: z.string().optional().describe("Module description, from the approved plan"),
      chapters: z
        .array(
          z.object({
            title: z.string().min(1),
            objective: z.string().min(1).describe("What this specific chapter's demo should show/teach"),
          })
        )
        .min(1)
        .describe("The approved list of chapters, in order"),
    },
    safe(async ({ toolId, name, description, chapters }) => {
      const module = await clicktaApi.createModule(toolId, name);
      if (description) {
        await clicktaApi.updateModule(module.id, { description });
      }

      const createdChapters: { chapterId: string; title: string; objective: string }[] = [];
      let insertAfterOrder = 0;
      for (const chapter of chapters) {
        const created = await clicktaApi.addChapter(module.id, {
          title: chapter.title,
          type: "demo",
          description: chapter.objective,
          insertAfterOrder,
        });
        insertAfterOrder = created.order;
        createdChapters.push({ chapterId: created.id, title: chapter.title, objective: chapter.objective });
      }

      return textResult({
        moduleId: module.id,
        name: module.name,
        chapters: createdChapters,
        message:
          `Module created with ${createdChapters.length} planned chapter(s), none recorded yet. For each one, ` +
          `call clikta_start_recording with moduleId "${module.id}" and that chapter's chapterId so the ` +
          `recording links into its slot. Use clikta_list_modules / clikta_get_module any time to check progress ` +
          "— including in a later session, to resume where you left off.",
      });
    })
  );

  server.tool(
    "clikta_list_modules",
    "List the modules already planned/published for a Tool, with how many chapters each has. Use this to " +
      "check for an existing module (and avoid proposing an overlapping one with clikta_plan_module) or to " +
      "resume a module's progress — pair with clikta_get_module for the per-chapter detail.",
    { toolId: z.string().min(1).describe("Tool id, from clikta_list_tools") },
    safe(async ({ toolId }) => {
      const modules = await clicktaApi.listModules(toolId);
      return textResult(modules);
    })
  );

  server.tool(
    "clikta_get_module",
    "Full detail of one module: every chapter, in order, with whether it already has a recording attached " +
      "(and that recording's step count / publish status) or is still pending. Use this to pick up a " +
      "partially-recorded module — in this session or a later one — and see exactly which chapters are left.",
    { moduleId: z.string().min(1).describe("Module id, from clikta_create_module or clikta_list_modules") },
    safe(async ({ moduleId }) => {
      const module = await clicktaApi.getModule(moduleId);
      return textResult({
        id: module.id,
        name: module.name,
        description: module.description,
        chapters: module.chapters.map((c) => ({
          chapterId: c.id,
          order: c.order,
          title: c.title,
          objective: c.description,
          status: c.recording ? "recorded" : "pending",
          recording: c.recording
            ? { id: c.recording.id, name: c.recording.name, stepsCount: c.recording.steps.length, published: c.recording.published }
            : null,
        })),
      });
    })
  );
}
