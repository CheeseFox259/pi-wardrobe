// /wardrobe command dispatch.
//
// `list`, `show` and `explain` inspect; `install` reviews and, once the exact
// plan the user saw is approved, installs it into owned staging. Every result
// states plainly what is installed, what is active and what is only a
// proposal, and nothing outside this manager's own directories is written.
//
// `list` is read-only: it discovers and validates, and reports whether a
// snapshot already exists. Capturing happens when a preset is inspected.

import { PlanStore } from "./approval.mjs";
import { join } from "node:path";
import { WardrobeDiagnostic, describeFailure, WardrobeError } from "./diagnostics.mjs";
import { oneLine } from "./doctor.mjs";
import {
  executableDifference,
  idleRefusal,
  planModel,
  planPersona,
  planThinking,
  planTools,
} from "./apply.mjs";
import {
  appliedAgainst,
  effectiveStateOf,
  executableShapeOf,
  runningRevisionOf,
  sessionStateOf,
} from "./session.mjs";
import { repositoryKeyOf, resolveSelector } from "./identity.mjs";
import { readOverlay, readUserOverlay } from "./overlay.mjs";
import { renderResult } from "./render.mjs";
import { captureSource } from "./discover.mjs";
import { installApprovedPlan } from "./install.mjs";
import { diagnoseAll, resolvePresetKey, selectRevision } from "./revisions.mjs";
import { launchPlanOf, preflightLaunch } from "./launch.mjs";
import { isStale, leaseReason, LeaseStore } from "./lease.mjs";
import { stagingViewOf } from "./staging.mjs";
import { bindRequest, BindingStore, LaunchRecords, resolveBinding } from "./binding.mjs";
import { composeFor, planFor } from "./review.mjs";
import { PresetStore, discover, sourceDirs } from "./store.mjs";

const COMMANDS = ["list", "show", "explain", "install", "status", "doctor", "use", "bind"];

const FIELD_KINDS = {
  schemaVersion: "metadata",
  id: "identity",
  name: "metadata",
  version: "metadata",
  description: "metadata",
  author: "metadata",
  compatibility: "metadata",
  extends: "composition",
  packages: "composition",
  resources: "composition",
  runtime: "preference",
  persona: "content",
};

/** Metadata a declaration describes about itself. */
const DECLARED_FIELDS = ["schemaVersion", "id", "name", "version", "description", "author", "compatibility"];

/**
 * The agent directory holding this manager's revisions.
 *
 * `WARDROBE_AGENT_DIR` wins when it is set, because a session running inside an
 * installed revision has a `PI_CODING_AGENT_DIR` that belongs to that revision,
 * not to the manager that owns it. Without the explicit pointer, `/wardrobe`
 * inside a launched revision would look for revisions inside the revision.
 */
function agentDir(env) {
  const dir = env.WARDROBE_AGENT_DIR || env.PI_CODING_AGENT_DIR;
  if (!dir) {
    throw WardrobeError.from(
      "Wardrobe cannot locate its agent directory",
      [],
      "PI_CODING_AGENT_DIR is not set; run /wardrobe inside Pi"
    );
  }
  return dir;
}

/** Parse `--flag value` pairs out of a command's arguments. */
function parseArgs(tokens) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(token.slice(2), true);
      } else {
        flags.set(token.slice(2), next);
        index += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

/**
 * Execute one /wardrobe invocation.
 *
 * @returns {Promise<{ok: boolean, command: string, result: object}>}
 */
export async function runCommand(input, { env = process.env, session = null } = {}) {
  const args = String(input ?? "").trim();
  const [name = "", ...tokens] = args.split(/\s+/).filter(Boolean);
  const command = name || "list";
  const { positional, flags } = parseArgs(tokens);

  if (!COMMANDS.includes(command)) {
    return failure(
      command,
      WardrobeError.from(
        `unknown /wardrobe subcommand ${JSON.stringify(command)}`,
        [],
        `available: ${COMMANDS.join(", ")}`
      )
    );
  }

  try {
    const dir = agentDir(env);
    if (command === "install") {
      // Awaited inside the try: a rejected promise must still become a
      // reported refusal rather than an unhandled error in the session.
      try {
        return await install(command, positional[0] ?? null, flags, { dir, env });
      } catch (error) {
        // A failed install keeps its record: it is diagnostic state, and the
        // user needs to see what was left behind.
        if (error?.staging) {
          const entry = failure(command, error);
          entry.result.staging = stagingViewOf(error.staging);
          return entry;
        }
        throw error;
      }
    }

    // `status` and `doctor` answer about installed revisions, not about
    // declarations: a preset that is not discovered locally still has a
    // revision, and its state must be reportable either way. Awaited inside
    // the try, so a refused selector is reported rather than thrown.
    if (command === "status") {
      return await status(command, positional.join(" "), { dir, env, session });
    }
    if (command === "doctor") {
      return await doctor(command, positional.join(" "), { dir, env });
    }
    if (command === "bind") {
      // Awaited inside the try, so a refused binding is reported rather than
      // thrown at the session.
      return await bind(command, positional, flags, { dir, env, session });
    }
    if (command === "use") {
      // Awaited inside the try, so a refused revision is reported rather than
      // thrown at the session.
      return await use(command, positional.join(" "), flags, { dir, env, session });
    }

    const store = new PresetStore(dir);
    const { presets, rejected } = discover(sourceDirs(dir, env));

    if (command === "list") {
      return await list(command, store, presets, rejected, { dir, env });
    }

    const selector = positional.join(" ");
    if (!selector) {
      return failure(
        command,
        WardrobeError.from(
          `/wardrobe ${command} needs a preset`,
          [],
          `usage: /wardrobe ${command} <preset> — see /wardrobe list`
        )
      );
    }
    const resolved = resolveSelector(selector, presets);
    if (!resolved.ok) return failure(command, resolved.error);

    // Inspecting a preset is what captures it.
    const snapshotDir = store.write(resolved.preset, resolved.preset.definition);
    const composed = await composition(resolved.preset, flags, { dir, env });
    // One measurement pass serves both halves of the answer: this preset's own
    // revisions, and the revision this process is running if it is one.
    const { reports, plans } = await diagnoseAll(dir, { env });
    const presetKey = repositoryKeyOf({ source: resolved.preset.source, id: resolved.preset.id });
    return success(command, {
      preset: { ...resolved.preset, state: "discovered", snapshotDir },
      definition: resolved.preset.definition,
      ...view(composed),
      revisions: reports
        .filter((report) => repositoryKeyOf(report.preset) === presetKey)
        .map(oneLine),
      bindings: bindingsDesiredBy(dir, reports, plans),
      // The session this is being read inside, where there is one.
      session: session ? sessionStateOf(session.branch()) : null,
      effective: session ? effectiveStateOf(sessionNow(session, { reports })) : null,
    });
  } catch (error) {
    return failure(command, error);
  }
}

/**
 * Compose a discovered preset the way the user asked to see it.
 *
 * A locally discovered declaration is presented as the capture composition
 * expects, so inheritance from a reviewed remote source resolves through the
 * same code path an installed one does.
 */
async function composition(preset, flags, { dir, env }) {
  const capture = {
    kind: "local",
    locator: preset.source,
    root: preset.source,
    treeDigest: null,
    presets: [preset],
  };
  const overlays = [readUserOverlay(dir)];
  const sessionPath = flags.get("overlay");
  if (typeof sessionPath === "string") overlays.push(readOverlay(sessionPath, "session"));

  return composeFor({
    captured: capture,
    preset,
    workDir: join(dir, "wardrobe", "captures"),
    registry: env.WARDROBE_REGISTRY,
    env,
    overlays: overlays.filter(Boolean),
    restrictions: restrictionsOf(flags),
  });
}

/**
 * Choices a preset may not override: CLI exclusions, the user's authorization
 * boundary, and an explicit user/CLI model choice.
 */
function restrictionsOf(flags) {
  const disabledTools = flags.get("disable-tool");
  const model = flags.get("model");
  return {
    disabledTools:
      typeof disabledTools === "string"
        ? disabledTools
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        : [],
    model: typeof model === "string" ? model : null,
  };
}

/** The described environment every inspecting command reports. */
function view({ layers, composed, executable, change }) {
  return {
    layers: layers.map((layer) => ({
      kind: layer.kind,
      identity: layer.identity,
      source: layer.captured?.locator ?? null,
      revision: layer.captured?.commit ?? layer.captured?.version ?? null,
    })),
    packages: composed.packages,
    resources: composed.resources.map(publicSelector),
    runtime: composed.runtime,
    persona: composed.persona,
    disabled: composed.runtime.tools.disabled,
    unmet: composed.runtime.tools.unmet,
    executable,
    // What the overlays changed. Soft by construction, so this is reported to
    // show that an overlay did not quietly require a new reviewed revision.
    revision: change,
    fields: composedFields(composed, layers),
    proposals: proposals(composed),
  };
}

/** The part of a folded selector a result carries; internal folds stay out. */
function publicSelector(selector) {
  return {
    package: selector.package,
    kind: selector.kind,
    generic: selector.generic,
    include: selector.include,
    exclude: selector.exclude,
    loaded: selector.loaded,
    excluded: selector.excluded,
    origins: selector.origins,
  };
}

/**
 * Produce — never perform — an install.
 *
 * Discovery captures the source and reads registry metadata. Nothing is
 * installed and no configuration is changed, whether the user approves,
 * declines, or cancels.
 */
async function install(command, source, flags, { dir, env }) {
  if (!source) {
    return failure(
      command,
      WardrobeError.from("install needs a source", [], "e.g. npm:@scope/preset@1.0.0 or git:<url>@<sha>")
    );
  }
  const plans = new PlanStore(dir);
  const captured = await captureSource(source, {
    workDir: join(dir, "wardrobe", "captures"),
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    registry: env.WARDROBE_REGISTRY,
  });

  const wanted = typeof flags.get("preset") === "string" ? flags.get("preset") : null;
  if (captured.presets.length === 0) {
    return failure(
      command,
      WardrobeError.from("source declares no presets", [
        new WardrobeDiagnostic({
          path: "",
          reason: `${captured.locator} contains no valid preset.json`,
        }),
      ])
    );
  }
  if (wanted === null && captured.presets.length > 1) {
    return failure(
      command,
      WardrobeError.from(
        `source declares ${captured.presets.length} presets; explicit selection is required`,
        captured.presets.map(
          (preset) =>
            new WardrobeDiagnostic({
              path: "",
              reason: `candidate: ${preset.path} (${preset.definition.name})`,
            })
        ),
        `re-run with --preset <path>, e.g. --preset ${captured.presets[0].path}`
      )
    );
  }
  const preset = wanted
    ? captured.presets.find((entry) => entry.path === wanted)
    : captured.presets[0];
  if (!preset) {
    return failure(
      command,
      WardrobeError.from("no preset at that path", [], `available: ${captured.presets.map((p) => p.path).join(", ")}`)
    );
  }

  const userOverlay = readUserOverlay(dir);
  const sealed = await planFor({
    captured,
    preset,
    workDir: join(dir, "wardrobe", "captures"),
    registry: env.WARDROBE_REGISTRY,
    env,
    overlays: userOverlay ? [userOverlay] : [],
    // A restriction given at review time applies to what is being installed,
    // not only to what `explain` prints. Otherwise a plan could be approved for
    // a preset whose requirements the session will not be allowed to meet.
    restrictions: restrictionsOf(flags),
  });
  const quoted = typeof flags.get("confirm") === "string" ? flags.get("confirm") : null;
  // Without a quoted digest nothing is installed and no configuration changes:
  // approval is what separates a review from an install.
  if (quoted === null) {
    plans.save(sealed);
    return success(command, { state: "awaiting-approval", plan: sealed, approvedAt: null });
  }

  if (quoted !== sealed.digest) {
    return failure(
      command,
      WardrobeError.from("approval digest does not match the plan", [
        new WardrobeDiagnostic({
          path: "/confirm",
          reason: `you quoted ${quoted}, the plan is ${sealed.digest}`,
        }),
        new WardrobeDiagnostic({
          path: "",
          reason: "the source or its artifacts changed since the plan was displayed",
        }),
      ])
    );
  }

  const approved = plans.approve({ planId: sealed.planId, digest: sealed.digest });
  const staging = await installApprovedPlan({
    plan: approved,
    agentDir: dir,
    env,
    registry: env.WARDROBE_REGISTRY,
  });

  return success(command, {
    state: staging.state,
    plan: sealed,
    approvedAt: approved.approved.at,
    installed: staging.state === "available",
    staging: stagingViewOf(staging.record, {
      selected: staging.attempt,
      alreadyAvailable: staging.alreadyAvailable,
    }),
  });
}

/**
 * Every installed revision, one line each, in stored order.
 *
 * Intended configuration is reported next to observed state, and the two are
 * never merged: a record that says `available` while the measurement says
 * `drifted` is reported as exactly that.
 */
async function status(command, selector, { dir, env, session }) {
  const { reports, unreadable, plans } = await diagnoseAll(dir, { env });
  const selected = selector ? selectRevision(reports, selector, { unreadable }) : null;
  const running = session ? runningRevisionOf({ agentDir: session.agentDir, reports }) : null;
  const runningRevision = running?.revision ?? (session?.baseline?.()?.revision ?? null);
  const runningPreset = running
    ? repositoryKeyOf(running.preset)
    : (session?.baseline?.()?.preset ?? null);
  const runningBinding = runningPreset ? new BindingStore(dir).read(runningPreset) : null;
  const restrictions = [
    ...new Set([
      ...(runningBinding?.restrictions ?? []),
      ...(session?.restrictions?.() ?? []),
    ]),
  ];

  return success(command, {
    // A binding that cannot be satisfied counts against how healthy this is:
    // reporting the revisions that happen to be installed while a binding is
    // unmet would let a failed recovery look healthy.
    state: bindingAwareSummary(
      dir,
      reports,
      plans,
      selected?.state ?? reportsSummary(reports)
    ),
    selected: selected ? oneLine(selected) : null,
    revisions: reports.map(oneLine),
    bindings: new BindingStore(dir).list().map(bindingViewOf),
    // What each binding would run now, beside what this session is running.
    // The two are separate facts and a mismatch is the answer.
    desired: bindingsDesiredBy(dir, reports, plans),
    latestLaunch: new LaunchRecords(dir).latest(),
    // What this session is actually using, where there is a session to ask.
    // Reported beside what it last recorded wanting, because those are
    // different facts.
    session: session ? sessionStateOf(session.branch()) : null,
    effective: session ? effectiveStateOf(sessionNow(session, { reports })) : null,
    pid: session ? (session.pid ?? process.pid) : null,
    codeState: session ? {
      revision: runningRevision,
      preset: runningPreset,
    } : null,
    restrictions,
    block: session?.block?.() ?? null,
    unreadable,
  });
}

/**
 * Everything `status` and `explain` want to know about the live session.
 *
 * Two revisions are named, because they are different facts: the revision whose
 * code is running, and the revision whose preferences this session adopted.
 * After a soft change they differ, and collapsing them into one would report an
 * environment that never existed.
 */
function sessionNow(session, { reports = [] } = {}) {
  const model = session.model();
  const running = runningRevisionOf({ agentDir: session.agentDir, reports });
  const runningRevision = running?.revision ?? (session.baseline?.()?.revision ?? null);
  return {
    runningRevision,
    adoptedFrom: sessionStateOf(session.branch()).revision ?? null,
    tools: session.activeTools(),
    model,
    thinking: session.thinkingLevel(),
    persona: session.personaAppended(),
  };
}

/** The full diagnosis for one revision, or for every revision. */
async function doctor(command, selector, { dir, env }) {
  const { reports, unreadable, plans } = await diagnoseAll(dir, { env });
  const selected = selector ? selectRevision(reports, selector, { unreadable }) : reports;
  const chosen = Array.isArray(selected) ? selected : [selected];
  return success(command, {
    // A binding that cannot be satisfied is part of how healthy this manager
    // is: reporting the revisions available while a binding is unmet would let a
    // failed recovery look healthy.
    state: bindingAwareSummary(dir, reports, plans, reportsSummary(chosen)),
    revisions: chosen,
    bindings: new BindingStore(dir).list().map(bindingViewOf),
    desired: bindingsDesiredBy(dir, reports, plans),
    unreadable,
  });
}

/**
 * The launch plan for using a revision in a new process.
 *
 * This is a plan, not a launch. It starts nothing, so it cannot embed another
 * TUI, and it says what a launch would add rather than claiming to remove
 * anything an older session left behind.
 */
/**
 * Record what a preset is meant to run.
 *
 * A deliberate act: the mode and the target are chosen here, never inferred.
 * Strict requires a revision to be named, and nothing about this command
 * approves code — an installation is still an installation.
 */
async function bind(command, positional, flags, { dir, env, session = null }) {
  const store = new BindingStore(dir);
  const wanted = flags.get("mode");
  const revision = typeof flags.get("revision") === "string" ? flags.get("revision") : null;
  const selector = positional[0] ?? null;
  // Naming a revision is how strict is asked for; naming a mode overrides that.
  const mode = typeof wanted === "string" ? wanted : revision ? "strict" : "follow";

  if (!selector) {
    // With no preset named, this is a read: what is bound, and in what mode.
    const bindings = store.list();
    return success(command, {
      mode: "read",
      bindings: bindings.map(bindingViewOf),
      latestLaunch: new LaunchRecords(dir).latest(),
      state: bindings.length === 0 ? "unbound" : "bound",
      installed: false,
      active: false,
    });
  }

  // A short key is recorded as the canonical identity, so the binding is not
  // left pointing at something a rename would change.
  const { reports, plans } = await diagnoseAll(dir, { env });
  const canonical = resolvePresetKey(selector, reports);
  if (!canonical.ok) {
    return failure(
      command,
      WardrobeError.from("the preset to bind is not named unambiguously", [
        new WardrobeDiagnostic({ path: "/bind/preset", reason: canonical.reason }),
        ...canonical.candidates.map(
          (entry) => new WardrobeDiagnostic({ path: "/bind/preset", reason: `candidate: ${entry}` })
        ),
      ], "equal ids from different sources are not interchangeable")
    );
  }

  // The previous binding is read by the canonical key: looking it up by the
  // short name that was typed would find nothing and silently reset its
  // history.
  const previous = store.read(canonical.presetKey);
  const request = bindRequest({
    preset: canonical.presetKey,
    mode,
    revision,
    restrictions: listFlags(flags, "restrict-tool"),
    soft: session ? { persona: session.personaAppended() } : null,
    previous,
    sessionId: session?.sessionId ?? null,
  });
  if (!request.ok) {
    return failure(
      command,
      WardrobeError.from("the binding cannot be recorded", [
        new WardrobeDiagnostic({ path: "/bind/mode", reason: request.reason }),
        ...(mode === "strict"
          ? [new WardrobeDiagnostic({ path: "", reason: "strict pins one exact revision by name" })]
          : []),
      ], "an unknown or ambiguous binding would be resolved by guesswork later")
    );
  }

  // Binding a mode says what should be true at the next launch; it does not
  // make it true now. What is actually available is reported beside it.
  const resolved = resolveBinding({ binding: request.record, reports, plans });
  const target = resolved.ok ? reports.find((entry) => entry.revision === resolved.revision.revision) : null;
  // What the revision this resolves to configures, so a later resume can tell
  // the same configuration from the same directory.
  const record = {
    ...request.record,
    configurationDigest: target?.lock?.configuration?.digest ?? request.record.configurationDigest,
  };
  const written = store.write(record);
  return success(command, {
    state: resolved.ok ? "bound" : "bound-unavailable",
    mode: written.mode,
    binding: bindingViewOf(written),
    resolves: resolved.ok
      ? { revision: resolved.revision.revision, state: resolved.revision.state }
      : { revision: null, reason: resolved.reason },
    migration: resolved.migration ?? null,
    restrictions: resolved.restrictions ?? [],
    installed: false,
    active: false,
  });
}

/**
 * What every binding would run right now, and whether it can.
 *
 * A binding that cannot be resolved is reported as unmet rather than left out:
 * an absent line would read like there was nothing to bind.
 */
function bindingsDesiredBy(agentDir, reports, plans) {
  return new BindingStore(agentDir).list().map((binding) => {
    const resolved = resolveBinding({ binding, reports, plans });
    return {
      preset: binding.preset,
      mode: binding.mode,
      pinned: binding.revision ?? null,
      available: resolved.ok,
      revision: resolved.ok ? resolved.revision.revision : null,
      state: resolved.ok ? resolved.revision.state : null,
      reason: resolved.reason,
      restrictions: resolved.restrictions ?? [],
      migrations: (binding.migrations ?? []).map((entry) => ({
        at: entry.at,
        from: entry.from,
        to: entry.to,
        reason: entry.reason,
      })),
      unreadable: binding.unreadable ?? null,
    };
  });
}

/** The most serious state, counting a binding that cannot be satisfied. */
function bindingAwareSummary(agentDir, reports, plans, fallback) {
  const desired = bindingsDesiredBy(agentDir, reports, plans);
  if (desired.some((entry) => !entry.available && !entry.unreadable)) return "unmet-binding";
  if (desired.some((entry) => entry.unreadable)) return "unreadable-binding";
  return fallback;
}

/** `--flag a --flag b` as a list, in the order the user wrote them. */
function listFlags(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** A binding in report form: intent and evidence, never contents. */
function bindingViewOf(binding) {
  return {
    preset: binding.preset,
    mode: binding.mode,
    revision: binding.revision ?? null,
    configurationDigest: binding.configurationDigest ?? null,
    restrictions: binding.restrictions ?? [],
    soft: binding.soft ?? null,
    lastLaunched: binding.lastLaunched ?? null,
    durable: binding.durable !== false,
    boundFromSession: binding.boundFromSession ?? null,
    migrations: (binding.migrations ?? []).map((entry) => ({
      at: entry.at,
      from: entry.from,
      to: entry.to,
      mode: entry.mode,
      reason: entry.reason,
    })),
    unreadable: binding.unreadable ?? null,
  };
}

/**
 * The launch plan for using a revision in a new process.
 *
 * This is a plan, not a launch. It names what a launch would add and what it
 * would run, and it says plainly that it neither removes old extension effects
 * nor runs inside the current session.
 */
async function use(command, selector, flags, { dir, env, session = null }) {
  if (!selector) {
    return failure(
      command,
      WardrobeError.from(
        "/wardrobe use needs a revision",
        [],
        "e.g. /wardrobe use <revision|preset> — see /wardrobe status for what is installed"
      )
    );
  }
  const runId = `plan-${Date.now().toString(36)}`;
  const prepared = await preflightLaunch({
    agentDir: dir,
    selector,
    env,
    runId,
    sessionPath: typeof flags.get("session") === "string" ? flags.get("session") : null,
  });
  // A lease that cannot be read is held, not absent: ownership that cannot be
  // established is not ownership that has been released.
  const held = new LeaseStore(dir).read(prepared.report.revision);
  const ownLease = Boolean(held && session && held.childPid === session.pid);
  if (held && !isStale(held) && !ownLease) {
    return failure(
      command,
      WardrobeError.from(
        `revision ${prepared.report.revision} is busy`,
        [
          new WardrobeDiagnostic({
            path: "/leases",
            reason: leaseReason(held),
          }),
          new WardrobeDiagnostic({
            path: "",
            reason: "one revision is one writer; a launch plan for a busy revision would be a plan nobody can follow",
          }),
        ],
        "wait for it to finish, or plan a different revision"
      )
    );
  }

  // A difference this process cannot adopt is a new-process launch, not a
  // preference change, and it is offered as a plan rather than performed.
  const sameRuntime = await softUse({ agentDir: dir, env, session, target: prepared });
  if (sameRuntime) return sameRuntime;

  const plan = launchPlanOf({
    report: prepared.report,
    plan: prepared.plan,
    sessionDir: prepared.sessionDir,
    agentDir: dir,
  });
  return success(command, {
    state: prepared.report.state,
    kind: "full-switch",
    launchPlan: plan,
    diagnostics: prepared.diagnostics.map((entry) => entry.toJSON()),
    installed: false,
    active: false,
  });
}

/**
 * Apply a `use` inside this process when it is only preferences that differ.
 *
 * Returns null when the request is a full switch, so the caller offers the
 * launch plan instead. The refusal reasons are returned rather than thrown so
 * that a busy session produces a report the user can read, not an error.
 */
async function softUse({ agentDir, env, session, target }) {
  if (!session) return null;
  const { reports, plans } = await diagnoseAll(agentDir, { env });
  const current = runningRevisionOf({ agentDir: session.agentDir, reports });
  const currentPlan = current ? plans.get(current.revision) ?? null : null;
  const executable = executableDifference({
    current: current ? executableShapeOf({ report: current, plan: currentPlan }) : null,
    target: executableShapeOf({ report: target.report, plan: target.plan }),
  });
  if (executable.length > 0) return null;

  const refusal = idleRefusal({ idle: session.isIdle(), compacting: session.isCompacting() });
  const tools = planTools({
    wanted: target.plan.runtime?.tools ?? {},
    current: session.activeTools(),
    available: session.availableTools(),
  });
  const currentModel = session.model();
  const model = planModel({
    preference: target.plan.runtime?.model ?? null,
    effective: currentModel ? `${currentModel.provider}/${currentModel.id}` : null,
    // A model this session carries that the revision it runs does not declare
    // is the user's own choice, made in this process.
    chosenHere:
      currentModel && declaredModelOf(currentPlan) !== `${currentModel.provider}/${currentModel.id}`
        ? `${currentModel.provider}/${currentModel.id}`
        : null,
  });
  const thinking = planThinking({
    preference: target.plan.runtime?.thinking ?? null,
    effective: session.thinkingLevel(),
  });
  const state = session.personaAppended();
  const persona = planPersona({ wanted: target.plan.persona?.append ?? [], active: state });

  const intended = {
    // The declared selection, not the one that took: a name this runtime could
    // not provide has to appear as not applied rather than disappear.
    tools: tools.intended,
    model: model.applies ? model.requested : model.effective,
    thinking: thinking.applies ? thinking.requested : thinking.effective,
    persona: persona.resulting,
  };
  const diagnostics = preparedToDiagnostics({ tools, model, thinking });

  if (refusal) {
    return failure(
      "use",
      WardrobeError.from("this session is not idle", [
        new WardrobeDiagnostic({ path: "/use", reason: refusal }),
        ...diagnostics.map((entry) => new WardrobeDiagnostic(entry)),
      ], "nothing was changed; re-run when the session is idle")
    );
  }

  if (tools.changed) session.setActiveTools(tools.resulting);
  if (model.applies) {
    const at = model.requested.indexOf("/");
    const provider = model.requested.slice(0, at);
    const id = model.requested.slice(at + 1);
    const resolved = session.resolveModel(provider, id);
    if (!resolved.summary) {
      diagnostics.push({
        path: "/runtime/model",
        reason: `no model named ${model.requested} exists here`,
        hint: "a preference cannot introduce a model that is not available; your model is unchanged",
      });
    } else if (resolved.hasAuth === false) {
      diagnostics.push({
        path: "/runtime/model",
        reason: `${model.requested} is available but has no credentials here`,
        hint: "your model is unchanged; this manager never introduces authentication",
      });
    } else if (!(await session.setModel(resolved.model))) {
      diagnostics.push({
        path: "/runtime/model",
        reason: `Pi refused ${model.requested}`,
        hint: "your model is unchanged",
      });
    }
  }
  if (thinking.applies) session.setThinkingLevel(thinking.requested);

  const personaState = [...persona.resulting];
  if (persona.changed) session.adopt(personaState);

  // Record what this session now prefers, then read the effective state back.
  // The order matters: the instructions a session carries are the ones on its
  // branch, so reading before recording would report the previous revision's.
  const baseline = session.baseline?.() ?? null;
  session.remember({
    preset: baseline?.preset ?? repositoryKeyOf(target.report.preset),
    mode: baseline?.mode ?? "follow",
    revision: target.report.revision,
    appliedAt: new Date().toISOString(),
    tools: session.activeTools(),
    model: session.model(),
    thinking: session.thinkingLevel(),
    persona: personaState,
  });

  // What is in effect now, read from the runtime and from the session's own
  // record — never what was asked for.
  const effective = effectiveStateOf({
    tools: session.activeTools(),
    model: session.model(),
    thinking: session.thinkingLevel(),
    persona: session.personaAppended(),
  });
  const rows = appliedAgainst({ intended, effective });

  return success("use", {
    state: rows.every((row) => row.applied) ? "applied" : "partly-applied",
    kind: "soft",
    // The process is untouched: same revision, same code, same PID.
    revision: target.report.revision,
    applied: rows,
    effective,
    intended,
    diagnostics: diagnostics.map((entry) => new WardrobeDiagnostic(entry).toJSON()),
    installed: false,
    active: false,
  });
}

/** The model the revision this session is running declares, if any. */
function declaredModelOf(plan) {
  const declared = plan?.runtime?.model?.value;
  return typeof declared === "string" ? declared : null;
}

/** Turn a plan's refusals into reportable diagnostics. */
function preparedToDiagnostics({ tools, model, thinking }) {
  const out = [];
  for (const entry of tools.unmet) {
    out.push({
      path: "/runtime/tools",
      reason: `tool ${entry.tool} is wanted but ${entry.reason}`,
      hint: "the rest of the selection is applied; this name is not a problem anything here can fix",
    });
  }
  if (model.requested && !model.applies) {
    out.push({ path: "/runtime/model", reason: model.reason, hint: null });
  }
  if (thinking.reason) {
    out.push({ path: "/runtime/thinking", reason: thinking.reason, hint: null });
  }
  return out;
}

/** The most serious state present, named plainly. */
function reportsSummary(reports) {
  if (reports.length === 0) return "none-installed";
  const states = reports.map((report) => report.state);
  for (const state of ["drifted", "failed", "missing", "unverified"]) {
    if (states.includes(state)) return state;
  }
  return "available";
}

async function list(command, store, presets, rejected, { dir, env }) {
  const { reports, unreadable } = await diagnoseAll(dir, { env });
  return {
    ok: true,
    command,
    result: {
      ok: true,
      command,
      presets: presets.map((preset) => ({
        source: preset.source,
        id: preset.id,
        name: preset.name,
        version: preset.version,
        state: "discovered",
        snapshot: store.snapshotOf(preset),
      })),
      // Rejections are flattened to plain data: this result is appended to the
      // session and must survive serialization.
      rejected: rejected.map(serialiseRejection),
      // Revisions are measured, not assumed: this list reports what is
      // installed here and what state each one is actually in.
      revisions: reports.map(oneLine),
      unreadable,
      installed: false,
      active: false,
    },
  };
}

/**
 * Every composed value with the layer it came from.
 *
 * Metadata describes the declaration itself; every other value names the layer
 * that contributed it, because "high" means nothing without knowing who asked
 * for it and which revision that was.
 */
function composedFields(composed, layers) {
  // The preset layer is the declaration a user asked about; a user or session
  // overlay sits above it and must not be mistaken for it.
  const declaration = layers.find((layer) => layer.kind === "preset") ?? layers.at(-1);
  const origin = `preset definition captured from ${declaration.preset?.capturedFrom ?? declaration.identity}`;
  const out = [];
  for (const key of DECLARED_FIELDS) {
    if (declaration.definition[key] === undefined) continue;
    walkField(declaration.definition[key], `/${key}`, FIELD_KINDS[key] ?? "metadata", origin, out);
  }

  out.push({ path: "/packages", kind: "composition", origin, applied: true, container: true });
  for (const entry of composed.packages) {
    const from = layerOrigin(entry.origin);
    out.push(field(`/packages/${entry.alias}/source`, entry.source, "composition", from));
    out.push(field(`/packages/${entry.alias}/version`, entry.version, "composition", from));
    out.push(field(`/packages/${entry.alias}/resource`, entry.canonical, "composition", from));
  }

  for (const selector of composed.resources) {
    const key = `/resources/${selector.package}:${selector.kind}`;
    out.push({
      path: key,
      kind: "composition",
      origin: describeOrigin(selectorOrigin(selector)),
      applied: true,
      container: true,
    });
    // Each loaded path is attributed to the layer that selected it, which is
    // not always the layer that wrote the selector it survives under.
    for (const path of selector.loaded) {
      out.push(field(`${key}/loaded/${path}`, path, "composition", pathOrigin(selector, path)));
    }
    for (const excluded of selector.excluded) {
      out.push({
        ...field(
          `${key}/excluded/${excluded.path}`,
          excluded.path,
          "composition",
          layerOrigin(excluded.origin)
        ),
        reason: excluded.reason,
      });
    }
  }

  out.push({ path: "/runtime", kind: "preference", origin, applied: false, container: true });
  const { tools, thinking, model } = composed.runtime;
  tools.enabled.forEach((entry, index) => {
    out.push(field(`/runtime/tools/enable/${index}`, entry.tool, "preference", layerOrigin(entry)));
  });
  tools.disabled.forEach((entry, index) => {
    out.push({
      ...field(`/runtime/tools/disable/${index}`, entry.tool, "preference", layerOrigin(entry)),
      reason: entry.reason,
    });
  });
  if (thinking) {
    out.push(field("/runtime/thinking", thinking.value, "preference", layerOrigin(thinking)));
  }
  if (model.value !== null) {
    out.push({
      ...field("/runtime/model", model.value, "preference", {
        layer: model.layer ?? model.winner,
        identity: model.identity ?? null,
      }),
      reason: model.reason ?? null,
    });
  }

  out.push({ path: "/persona", kind: "content", origin, applied: true, container: true });
  composed.persona.append.forEach((entry, index) => {
    out.push(field(`/persona/append/${index}`, entry.text, "content", layerOrigin(entry)));
  });
  return out;
}

function field(path, value, kind, origin) {
  return {
    path,
    value,
    kind,
    origin: describeOrigin(origin),
    applied: kind !== "preference",
    container: false,
  };
}

function describeOrigin(origin) {
  if (!origin) return "no layer";
  return origin.identity ? `${origin.layer} layer (${origin.identity})` : `${origin.layer} layer`;
}

function layerOrigin(origin) {
  if (!origin) return null;
  return { layer: origin.layer ?? null, identity: origin.identity ?? null };
}

/** The layer that wrote a selector, or the earliest one that contributed. */
function selectorOrigin(selector) {
  const origin = selector.origins[0];
  return origin ? layerOrigin(origin) : null;
}

/** The layer that selected one path, falling back to the selector's own. */
function pathOrigin(selector, path) {
  // The most recent action for a path is the effective one: a higher layer
  // re-including a path overrides the base that first named it.
  const origin = selector.origins.findLast((entry) => entry.path === path);
  return layerOrigin(origin ?? selector.origins[0]);
}

function walkField(value, path, kind, origin, out) {
  const applied = kind !== "preference";
  if (isContainer(value)) {
    out.push({ path, kind, origin, applied, container: true });
    for (const [key, child] of Object.entries(value)) {
      walkField(child, `${path}/${key}`, kind, origin, out);
    }
    return;
  }
  out.push({ path, value, kind, origin, applied, container: false });
}

function isContainer(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Preferences that are declared but deliberately not applied.
 *
 * A preference the user or the CLI already decided is reported as such rather
 * than as something `use` would do, and an unmet preference keeps its reason.
 */
function proposals(composed) {
  const { tools, thinking, model } = composed.runtime;
  const out = [];
  if (thinking) out.push(`/wardrobe use would propose thinking level ${thinking.value} (${thinking.layer})`);
  if (model.value !== null) {
    out.push(
      model.winner === "user"
        ? `/wardrobe use would propose model ${model.value}, but an explicit user or CLI choice wins`
        : `/wardrobe use would propose model ${model.value}`
    );
  }
  if (tools.enabled.length > 0) {
    out.push(
      `/wardrobe use would propose enabling tools: ${tools.enabled.map((entry) => entry.tool).join(", ")}`
    );
  }
  if (tools.disabled.length > 0) {
    out.push(
      `/wardrobe use would propose disabling tools: ${tools.disabled.map((entry) => entry.tool).join(", ")}`
    );
  }
  for (const entry of tools.unmet) {
    out.push(
      `/wardrobe use would propose enabling tools: ${entry.tool} — refused: ${entry.reason}`
    );
  }
  return out;
}

function serialiseRejection(error) {
  return { ...error.toJSON(), text: describeFailure(error) };
}

/** Attach the rendered text so the extension does not re-derive it. */
export function withText(entry) {
  return { ...entry, text: entry.ok ? renderResult(entry.result) : entry.result.text };
}

function success(command, result) {
  return { ok: true, command, result: { ok: true, command, installed: false, active: false, ...result } };
}

function failure(command, error) {
  return {
    ok: false,
    command,
    result: { ok: false, command, error, text: describeFailure(error) },
  };
}
