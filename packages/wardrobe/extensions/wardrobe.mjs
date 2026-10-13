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
import { SESSION_TYPE, sessionStateOf, processBaselineOf } from "../src/session.mjs";
import { BindingStore, recordMigration } from "../src/binding.mjs";
import { diagnoseAll } from "../src/revisions.mjs";
import { idleRefusal } from "../src/apply.mjs";
import { reconcileState } from "../src/reconcile.mjs";

export const RESULT_TYPE = "wardrobe.result";

export default function (pi) {
  const revisionDir = process.env.PI_CODING_AGENT_DIR ?? "";
  const baseline = processBaselineOf(revisionDir);

  // Instructions the session has adopted are contributed as prompt guidelines
  // rather than as a replaced prompt: appending must leave every other part of
  // the prompt exactly as Pi built it.
  //
  // They are re-read on every session start rather than held in a variable for
  // the life of the process, so a session that resumed, or that forked a branch
  // which had adopted them, contributes the same instructions it had rather
  // than none.
  const adoptionsOf = (ctx) => {
    if (!ctx?.sessionManager?.getBranch) return [];
    return sessionStateOf(ctx.sessionManager.getBranch()).persona;
  };

  // What this revision declared, plus whatever this session adopted since. The
  // revision's own file is the start of the list and the branch carries the
  // changes on top of it; appending means neither can quietly drop the other.
  const instructionsFor = (ctx) => {
    let start = baseline?.persona ?? [];
    if (!baseline && revisionDir) {
      try {
        start = JSON.parse(
          readFileSync(join(revisionDir, "wardrobe", "session.json"), "utf8")
        ).persona ?? [];
      } catch {
        // Not a revision launch, or the file is not there: nothing to add.
      }
    }
    const seen = new Set();
    return [...start, ...adoptionsOf(ctx)].filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
  };
  let adopted = [];

  // Compaction state is a property of the session, not of a command: listening
  // per invocation would both leak handlers and miss a compaction that started
  // before the command arrived.
  let compacting = false;
  pi.on("compaction_start", () => (compacting = true));
  pi.on("compaction_end", () => (compacting = false));

  // Current blocked turn state, if branch reconciliation blocked the next model turn.
  let currentBlock = null;

  function checkIdleRefusal(ctx) {
    const isStreaming = ctx?.isStreaming ?? false;
    const isSessionIdle = !compacting && !isStreaming;
    return idleRefusal({ idle: isSessionIdle, compacting });
  }

  function recordSessionEntry(ctx, { mode, keptFrom = null, keptTo = null, thinking = null }) {
    pi.appendEntry(SESSION_TYPE, {
      preset: baseline.preset,
      mode: mode ?? baseline.mode,
      revision: baseline.revision,
      ...(keptFrom ? { keptFrom, keptTo } : {}),
      appliedAt: new Date().toISOString(),
      tools: pi.getActiveTools(),
      model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : null,
      thinking: thinking ?? ctx.thinkingLevel ?? null,
      persona: instructionsFor(ctx),
    });
  }

  async function applyRestorePlan(ctx, restorePlan) {
    if (restorePlan.tools.changed) {
      pi.setActiveTools(restorePlan.tools.resulting);
    }
    if (restorePlan.modelChanged && restorePlan.model.requested) {
      const at = restorePlan.model.requested.indexOf("/");
      if (at > 0) {
        const provider = restorePlan.model.requested.slice(0, at);
        const id = restorePlan.model.requested.slice(at + 1);
        const found = ctx.modelRegistry?.find?.(provider, id);
        if (found) {
          await pi.setModel(found);
        }
      }
    }
    if (restorePlan.thinking.changed && restorePlan.thinking.requested !== undefined) {
      pi.setThinkingLevel(restorePlan.thinking.requested);
    }
  }

  function describeRestoreChanges(restorePlan) {
    const parts = [];
    if (restorePlan.tools.changed) parts.push(`tools: ${restorePlan.tools.resulting.join(", ")}`);
    if (restorePlan.modelChanged) parts.push(`model: ${restorePlan.model.requested}`);
    if (restorePlan.thinking.changed) parts.push(`thinking: ${restorePlan.thinking.requested}`);
    if (restorePlan.personaChanged) parts.push("instructions updated");
    return parts.length ? parts.join("; ") : "none";
  }

  async function reconcile(ctx, { isStartup = false } = {}) {
    const managerDir = process.env.WARDROBE_AGENT_DIR || revisionDir;
    if (!managerDir || !baseline) {
      currentBlock = null;
      return null;
    }

    const branchEntries = ctx?.sessionManager?.getBranch?.() ?? [];
    const rawDesired = sessionStateOf(branchEntries);
    const bindingStore = new BindingStore(managerDir);
    const binding = baseline.preset ? bindingStore.read(baseline.preset) : null;
    const { reports, plans } = await diagnoseAll(managerDir, { env: process.env });
    const sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;

    const currentTools = pi.getActiveTools();
    const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
    const currentThinking = ctx.thinkingLevel ?? null;
    const currentPersona = instructionsFor(ctx);

    const runtime = {
      tools: currentTools,
      availableTools: pi.getAllTools().map((t) => t.name),
      model: currentModel,
      thinking: currentThinking,
      persona: currentPersona,
      isIdle: () => ctx.isIdle(),
      isCompacting: () => compacting,
    };

    const processState = {
      preset: baseline.preset,
      mode: baseline.mode,
      revision: baseline.revision,
      tools: baseline.tools ?? [],
      model: baseline.model ?? null,
      thinking: baseline.thinking ?? null,
      persona: baseline.persona ?? [],
      restrictions: binding?.restrictions ?? [],
    };

    const outcome = reconcileState({
      desired: rawDesired,
      baseline,
      processState,
      reports,
      plans,
      binding,
      sessionFile,
      runtime,
    });

    if (outcome.status === "blocked") {
      currentBlock = outcome;
      ctx.ui?.notify?.(
        `Turn blocked (${outcome.reason}): ${outcome.detail}.\nRelaunch: ${outcome.relaunchPlan.command}`,
        "error"
      );
      return outcome;
    }

    currentBlock = null;

    if (outcome.status === "follow-kept") {
      // 1. Record migration in durable binding store
      if (outcome.migration && binding) {
        const updatedBinding = recordMigration(binding, outcome.migration);
        bindingStore.write(updatedBinding);
      }

      // 2. Apply soft restores if compatible
      const refusal = checkIdleRefusal(ctx);
      if (!refusal && outcome.restorePlan) {
        await applyRestorePlan(ctx, outcome.restorePlan);
      }

      // 3. Record wardrobe.session entry on branch with keptFrom and keptTo
      recordSessionEntry(ctx, {
        mode: "follow",
        keptFrom: outcome.keptFrom,
        keptTo: outcome.keptTo,
        thinking: outcome.restorePlan?.thinking?.requested,
      });

      adopted = instructionsFor(ctx);
      ctx.ui?.notify?.(
        `Follow kept running revision ${outcome.keptTo} (branch desired ${outcome.keptFrom})`,
        "info"
      );
      return outcome;
    }

    if (outcome.status === "in-effect") {
      if (outcome.restorePlan && outcome.restorePlan.hasChanges) {
        const refusal = checkIdleRefusal(ctx);
        if (refusal) {
          ctx.ui?.notify?.(`Refused to restore branch preferences: ${refusal}`, "error");
          return outcome;
        }

        await applyRestorePlan(ctx, outcome.restorePlan);

        if (!isStartup) {
          recordSessionEntry(ctx, {
            mode: baseline.mode,
            thinking: outcome.restorePlan?.thinking?.requested,
          });
        }

        adopted = instructionsFor(ctx);
        const changes = describeRestoreChanges(outcome.restorePlan);
        ctx.ui?.notify?.(
          `Restored branch preferences (${changes})`,
          "info"
        );
      } else {
        adopted = instructionsFor(ctx);
      }
      return outcome;
    }

    return outcome;
  }

  pi.on("session_start", async (event, ctx) => {
    const effectiveContext = ctx ?? event.ctx ?? event;
    adopted = instructionsFor(effectiveContext);
    await reconcile(effectiveContext, { isStartup: true });
  });

  pi.on("session_tree", async (event, ctx) => {
    const effectiveContext = ctx ?? event.ctx ?? event;
    await reconcile(effectiveContext);
  });

  pi.on("input", async (event, ctx) => {
    if (currentBlock) {
      ctx.ui?.notify?.(
        `Turn blocked (${currentBlock.reason}): ${currentBlock.detail}.\nRelaunch: ${currentBlock.relaunchPlan.command}`,
        "error"
      );
      return { action: "handled" };
    }
  });

  // WHY before_agent_start sync: Pi clamps thinking level to "off" when no reasoning
  // model is bound at process startup, and resets thinking level to global defaults
  // whenever setModel() is called during extension initialization. When before_agent_start
  // fires, the turn's model is bound and authenticated, so re-applying the branch's verified
  // soft settings ensures the turn executes with the branch's desired thinking level and tool
  // selection.
  // We skip this entirely if the branch is blocked so tools are not mutated before a refusal,
  // and we filter tools against user restrictions so an excluded tool is never re-enabled.
  pi.on("before_agent_start", (event, ctx) => {
    if (currentBlock) return;

    if (adopted.length > 0) {
      const options = event.systemPromptOptions;
      options.promptGuidelines = [...(options.promptGuidelines ?? []), ...adopted];
    }
    const effectiveContext = ctx ?? event.ctx ?? event;
    const branchEntries = effectiveContext?.sessionManager?.getBranch?.() ?? [];
    const branchState = sessionStateOf(branchEntries);
    if (branchState.thinking && pi.getThinkingLevel?.() !== branchState.thinking) {
      pi.setThinkingLevel(branchState.thinking);
    }
    if (branchState.tools?.length > 0) {
      const managerDir = process.env.WARDROBE_AGENT_DIR || revisionDir;
      const binding = baseline?.preset ? new BindingStore(managerDir).read(baseline.preset) : null;
      const restrictedSet = new Set(binding?.restrictions ?? []);
      const allowed = branchState.tools.filter((t) => !restrictedSet.has(t));
      pi.setActiveTools(allowed);
    }
  });

  pi.registerCommand("wardrobe", {
    description: "Inspect Wardrobe presets and revisions: list, show, explain, install, status, doctor, use, bind, remove, release, retain",
    handler: async (args, ctx) => {
      const managerDir = process.env.WARDROBE_AGENT_DIR || revisionDir;
      const binding = baseline?.preset ? new BindingStore(managerDir).read(baseline.preset) : null;
      const session = capabilityOf(pi, ctx, {
        adopted: (lines) => (adopted = lines),
        compacting: () => compacting,
        instructions: () => instructionsFor(ctx),
        block: () => currentBlock,
        baseline: () => baseline,
        restrictions: () => binding?.restrictions ?? [],
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
function capabilityOf(pi, ctx, { adopted, compacting: isCompacting, instructions, block, baseline, restrictions }) {
  return {
    agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    managerAgentDir: process.env.WARDROBE_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? null,
    mode: ctx.mode,
    sessionId: ctx.sessionManager?.getSessionId?.() ?? null,
    pid: process.pid,
    block: () => block?.() ?? null,
    baseline: () => baseline?.() ?? null,
    restrictions: () => restrictions?.() ?? [],

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
