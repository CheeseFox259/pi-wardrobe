// /wardrobe — the Wardrobe manager entry point.
//
// This extension registers one command and nothing else. It declares no
// packages, no MCP servers, no browser tooling and no install scripts, so
// installing the manager never pulls in a reference preset or an engineering
// dependency.
//
// The command layer is a plain module with no Pi types in it, so it can be
// driven by a test as easily as by a session. Everything that needs the runtime
// — the active tools, the model, the thinking level, the system prompt, the
// branch — arrives here as a small capability object.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, withText } from "../src/commands.mjs";
import { SESSION_TYPE, sessionStateOf } from "../src/session.mjs";

export const RESULT_TYPE = "wardrobe.result";

export default function (pi) {
  // Instructions the session has adopted are contributed as prompt guidelines
  // rather than as a replaced prompt: appending must leave every other part of
  // the prompt exactly as Pi built it.
  //
  // They are re-read on every session start rather than held in a variable for
  // the life of the process, so a session that resumed, or that forked a branch
  // which had adopted them, contributes the same instructions it had rather
  // than none.
  const adoptionsOf = (ctx) => sessionStateOf(ctx.sessionManager.getBranch()).persona;

  // What this revision declared, plus whatever this session adopted since. The
  // revision's own file is the start of the list and the branch carries the
  // changes on top of it; appending means neither can quietly drop the other.
  const instructionsFor = (ctx) => {
    let start = [];
    try {
      start = JSON.parse(
        readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "wardrobe", "session.json"), "utf8")
      ).persona ?? [];
    } catch {
      // Not a revision launch, or the file is not there: nothing to add.
    }
    const seen = new Set();
    return [...start, ...adoptionsOf(ctx)].filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
  };
  let adopted = [];

  pi.on("session_start", (event) => {
    adopted = instructionsFor(event.ctx ?? event);
  });
  pi.on("before_agent_start", (event) => {
    if (adopted.length === 0) return;
    const options = event.systemPromptOptions;
    options.promptGuidelines = [...(options.promptGuidelines ?? []), ...adopted];
  });

  // Compaction state is a property of the session, not of a command: listening
  // per invocation would both leak handlers and miss a compaction that started
  // before the command arrived.
  let compacting = false;
  pi.on("compaction_start", () => (compacting = true));
  pi.on("compaction_end", () => (compacting = false));

  pi.registerCommand("wardrobe", {
    description: "Inspect Wardrobe presets and revisions: list, show, explain, install, status, doctor, use",
    handler: async (args, ctx) => {
      const session = capabilityOf(pi, ctx, {
        adopted: (lines) => (adopted = lines),
        compacting: () => compacting,
        instructions: () => instructionsFor(ctx),
      });
      const entry = withText(await runCommand(args, { session }));
      ctx.ui.notify(entry.text, entry.ok ? "info" : "error");
      // A structured record keeps the result machine-readable for scripting and
      // for checks that do not scrape terminal output.
      pi.appendEntry(RESULT_TYPE, { ...entry.result, text: entry.text });
      // Re-read what is in effect after the command: a command that adopted an
      // instruction has to reach the next request's prompt, and what counts as
      // adopted is the branch's own record.
      adopted = instructionsFor(ctx);
    },
  });
}

/**
 * The runtime the command layer may ask about.
 *
 * Every value is read from Pi at the moment it is asked for, never cached
 * across a turn: a command that reports the effective model has to mean the
 * model the next request would use.
 */
function capabilityOf(pi, ctx, { adopted, compacting: isCompacting, instructions }) {
  return {
    agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    mode: ctx.mode,
    sessionId: ctx.sessionManager?.getSessionId?.() ?? null,

    isIdle: () => ctx.isIdle(),
    isCompacting: () => isCompacting(),
    waitForIdle: () => ctx.waitForIdle(),

    activeTools: () => pi.getActiveTools(),
    availableTools: () => pi.getAllTools().map((tool) => tool.name),
    setActiveTools: (names) => pi.setActiveTools(names),

    model: () => (ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : null),
    thinkingLevel: () => ctx.thinkingLevel ?? null,
    setModel: (model) => pi.setModel(model),
    setThinkingLevel: (level) => pi.setThinkingLevel(level),

    /**
     * Find a declared preference in the catalogue, and whether it can be used.
     *
     * The full model object is returned as well as a summary because Pi sets a
     * model by identity, not by name; handing it a summary would be a guess.
     */
    resolveModel: (provider, id) => {
      const found = ctx.modelRegistry?.find?.(provider, id) ?? null;
      return {
        model: found,
        summary: found ? { id: found.id, provider: found.provider } : null,
        // `null` when the runtime cannot answer, which is not the same as "no
        // credentials" and must not be reported as one.
        hasAuth: found ? (ctx.modelRegistry.hasConfiguredAuth?.(found) ?? null) : null,
      };
    },

    systemPrompt: () => ctx.getSystemPrompt(),
    branch: () => ctx.sessionManager.getBranch(),

    /** Record what this session now prefers, on the branch it is on. */
    remember: (state) => pi.appendEntry(SESSION_TYPE, state),
    adopt: (lines) => adopted(lines),
    personaAppended: () => instructions(),
  };
}
