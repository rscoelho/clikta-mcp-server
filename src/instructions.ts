// Server-level MCP `instructions` — shown once to the connecting LLM client
// (Claude Desktop, Claude Code, ...), independent of any single tool's
// description. This is where the *process* lives: the order tools are meant
// to be called in, and the couple of rules that most affect the quality of
// the demo a user ends up with. Individual tool descriptions (tools.ts) only
// carry what's true about that one call; keep the workflow narrative here so
// it isn't duplicated/drifting across many separate strings.
export const CLIKTA_MCP_INSTRUCTIONS = `Clikta turns a recorded browser walkthrough into a shareable interactive demo/guide. This server drives a real browser on this machine. The quality of what the end user receives depends entirely on how you use these tools.

FIRST, decide the scope you're dealing with:

- A single, self-contained demo ("show how to invite a teammate") → skip straight to "Recording a single demo" below.
- A broader goal that's really several demos ("document the whole admin onboarding experience", "cover the settings area") → start with "Planning a module" below. Don't jump straight into recording for a goal this size — without a plan you'll likely record overlapping or incomplete demos and waste the user's time and AI credits re-doing them.

PLANNING A MODULE (a set of demos):

1. clikta_list_tools — check whether the product is already registered; clikta_create_tool if not (once per product).
2. clikta_list_modules / clikta_describe_tool (when you have a toolId) — check there isn't already a module covering this ground.
3. clikta_plan_module — propose a module: a name, a description, and 3-8 chapters, each one a separate demo. This is a PROPOSAL ONLY, nothing is saved yet.
4. STOP AND GET THE USER'S APPROVAL. Show them the proposed module name and the list of chapters. Let them add, remove, reorder or reword chapters before anything is created. This is the single most important checkpoint in the whole process — a module the user didn't actually review turns into wasted recording time on chapters they didn't want, or missing ones they did.
5. Once approved, clikta_create_module persists the module and its chapters (none recorded yet).
6. For each chapter, in order: follow "Recording a single demo" below, passing that chapter's moduleId/chapterId to clikta_start_recording so the finished recording fills that slot. After each chapter, tell the user briefly what's done and what's left — clikta_get_module shows exact progress, including across separate sessions if you (or the user) come back to this later.

RECORDING A SINGLE DEMO:

1. clikta_list_tools — check whether the product is already registered; clikta_create_tool if not.
2. clikta_describe_tool (when you have a toolId) — see what Clikta already knows: existing modules/demos and their steps, pages visited before. Skipping this risks silently re-recording something that already exists.
3. clikta_plan_demo — turn the objective into a short outline before touching the browser. Worth doing for anything beyond a trivial 1-2 step demo; it also flags when the objective is already covered by an existing recording.
4. clikta_start_recording — pass toolId when you have one (and moduleId/chapterId if this fills a planned module chapter). Prefer a staging/sandbox toolUrl over production; the tool warns you when a URL doesn't look like one, and you should get the user's explicit OK before taking real actions in production.
5. Drive the browser with clikta_navigate / clikta_click / clikta_type, treating the plan from step 3 as a loose checklist, not a script — deviate freely once the real page doesn't match what was assumed. Locate elements by role+name or visible text rather than raw CSS selectors; they survive minor UI differences much better. clikta_click refuses anything that looks destructive (delete, payment, unsubscribe, ...) unless confirm:true — don't override that without checking with the user first.
6. clikta_note after every meaningful action, explaining WHY you did it, not just what. This is not optional bookkeeping: it is the main signal Clikta's generator uses to write each step's description and the guide's introduction/conclusion. A recording with no notes produces a mechanically-worded guide even when every click succeeded.
7. clikta_finish_recording — stops the recording, generates the guide, publishes it, and returns the shareable link. Share that link with the user; don't call this before the plan/objective is actually fulfilled, since a short or incomplete recording still gets a guide generated from whatever was captured.

Two things that cost the user real resources, so don't call them needlessly: clikta_plan_demo/clikta_plan_module and the generation step inside clikta_finish_recording all spend AI credits — don't re-plan for a trivial rewording, and don't finish/regenerate a recording repeatedly when nothing about the captured steps changed. These tools (and recording via this server at all) also require a Pro/Team Clikta plan — a free-plan token gets a clear error from clikta_start_recording explaining that, rather than a bare auth failure.`;
