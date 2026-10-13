// Launching a verified revision in a real, isolated Pi process.
//
// Launching is the only step that makes a revision's resources load, so it is
// the only step that writes a selection into a revision's settings. It does so
// inside that revision's own agent directory: never the user's, never another
// revision's.
//
// What the child will get is decided before it starts, not discovered by a
// user mid-session. A revision that no longer measures as its lock refuses
// outright. A selected skill or prompt that Pi did not load, and a command two
// resources both registered, refuse too: the user approved one selection, and
// handing them a different one is not a launch. What cannot be observed from
// here — a tool an extension registers, an extension that registers nothing —
// is reported as unverified rather than passed or failed.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { dispatchPiCommand } from "./proc.mjs";
import { piCliOf } from "./lock.mjs";
import { leaseViewOf, LeaseStore } from "./lease.mjs";
import { probeLoadedState, reconcileSelection, selectedResourcesOf } from "./probe.mjs";
import { diagnoseAll, resolvePresetKey, selectRevision } from "./revisions.mjs";
import { BindingStore, LaunchRecords, recordMigration, resolveBinding } from "./binding.mjs";
import { repositoryKeyOf } from "./identity.mjs";

/** The built-in tools Pi itself provides, which need no package to register. */
const BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "codemode",
  "tool_search",
]);

/**
 * The settings that make exactly the approved selection load.
 *
 * Each declared package keeps every resource type filtered unless the plan
 * selected something of that type: a type with no selector loads nothing, so
 * writing the type at all would be describing code nobody approved.
 */
function activatedSettingsFor({ plan, inventory }) {
  const sources = new Map(inventory.map((entry) => [entry.alias, entry.source]));
  const packages = plan.installationSurfaces.map((surface) => {
    const declaration = {
      source: sources.get(surface.alias) ?? surface.source,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
    for (const selector of plan.resourceSelectors) {
      if (selector.package !== surface.alias) continue;
      declaration[selector.kind] = [...(selector.loaded ?? [])].sort();
    }
    return declaration;
  });

  const settings = { packages };
  const tools = toolSelectionFor(plan);
  if (tools.length > 0) settings.defaultTools = tools;
  // A declared thinking level belongs in the revision's own settings: a
  // revision that declares one should run at it rather than at whatever the
  // host defaults to. It is also load-bearing beyond intent — Pi reads this
  // setting unguarded, so a revision whose settings omit it cannot build a
  // request at all.
  const thinking = plan?.runtime?.thinking?.value ?? null;
  if (thinking) settings.defaultThinkingLevel = thinking;
  // Telemetry stays off for a managed revision directory. Two reasons, and the
  // second is not a preference: Pi 1.1.0 reads this setting unguarded, so a
  // revision whose settings omit it cannot complete a model turn at all
  // ("Cannot read properties of undefined (reading 'includes')"). This is the
  // manager's own directory, not anybody's personal environment, so choosing
  // here changes no one's baseline.
  settings.enableInstallTelemetry = false;
  return settings;
}

/**
 * The tool selection as Pi's own `defaultTools` syntax.
 *
 * Only `+name` and `-name` entries are written, so a preset's preference adds
 * to and subtracts from the inherited selection rather than replacing it. An
 * explicit user or CLI `--tools` choice still wins, because Pi applies those
 * over this setting.
 */
function toolSelectionFor(plan) {
  const runtime = plan?.runtime ?? null;
  if (!runtime?.tools) return [];
  return [
    ...(runtime.tools.enabled ?? []).map((entry) => `+${entry.tool}`),
    ...(runtime.tools.disabled ?? []).map((entry) => `-${entry.tool}`),
  ].sort();
}

/**
 * The session directory a launch will use.
 *
 * Always explicit. A revision that fell back to the user's session store would
 * read and write the user's own history, which is not this manager's to touch.
 */
function sessionDirFor({ revisionDir, explicit, runId }) {
  if (typeof explicit === "string" && explicit.trim()) return { path: explicit.trim(), explicit: true };
  return {
    path: join(revisionDir, "wardrobe", "sessions", runId),
    explicit: false,
  };
}

/**
 * How a resumed session is opened.
 *
 * Resuming names a session Pi already persisted, so it is handed `--session`
 * and the process continues that conversation rather than starting a new one. A
 * session that was never persisted cannot be resumed, and Pi is told so instead
 * of being pointed at a path that does not exist.
 */
function sessionArgsFor({ sessionDir, resume }) {
  if (typeof resume !== "string" || !resume.trim()) return { args: [], resumed: false };
  const path = resolvePath(resume.trim());
  if (!existsSync(path)) {
    throw WardrobeError.from(
      "the session to resume is not there",
      [new WardrobeDiagnostic({ path: "/launch/resume", reason: `${path} does not exist` })],
      "a session is persisted by the process that wrote it; run one first, or start a new session"
    );
  }
  return { args: ["--session", path], resumed: true, path };
}

/**
 * Decide what a launch should run, and prepare it.
 *
 * A named revision is honoured directly. A named *binding* is resolved through
 * its mode: follow takes the newest approved available revision of the same
 * source-qualified preset, strict takes the pinned one or refuses. Whether the
 * resources actually load is a separate question, asked by `observeSelection`
 * once the selection has been written.
 *
 * @returns {Promise<{ok: boolean, diagnostics: WardrobeDiagnostic[],
 *   report: object, plan: object, revisionDir: string, sessionDir: object,
 *   activation: object, cli: string, binding: object|null, migration: object|null}>}
 */
export async function preflightLaunch({
  agentDir,
  selector,
  env,
  sessionPath = null,
  runId,
  cwd,
}) {
  const { reports, unreadable, plans } = await diagnoseAll(agentDir, { env });
  if (reports.length === 0) {
    throw WardrobeError.from(
      "no revision has been installed here",
      unreadable.map((entry) => new WardrobeDiagnostic({ path: "", reason: entry.reason })),
      "run /wardrobe install <source> --confirm <digest> first"
    );
  }
  // A binding is recorded against the canonical preset identity, so a short key
  // has to be resolved to that before it can be looked up.
  const bindings = new BindingStore(agentDir);
  const canonical = resolvePresetKey(selector, reports);
  const binding = canonical.ok ? bindings.read(canonical.presetKey) : null;
  const resolved = binding
    ? resolveBinding({ binding, reports, plans })
    : { ok: true, mode: null, revision: selectRevision(reports, selector, { unreadable }), migration: null, restrictions: [] };

  if (!resolved.ok) {
    throw WardrobeError.from(
      `${binding.preset} cannot be launched in ${resolved.mode ?? "its"} mode`,
      [
        new WardrobeDiagnostic({ path: "/binding", reason: resolved.reason }),
        ...(resolved.restrictions ?? []).map(
          (entry) => new WardrobeDiagnostic({ path: "/restrictions", reason: entry })
        ),
        // Strict refuses and offers the way out; it never substitutes a newer
        // revision for the one that was pinned.
        ...(resolved.mode === "strict"
          ? [
              new WardrobeDiagnostic({
                path: "",
                reason:
                  "the pinned revision was not replaced with a newer one; switch to follow, or install and pin another revision deliberately",
              }),
            ]
          : []),
      ],
      "nothing was started and no binding was changed"
    );
  }

  const report = resolved.revision;
  const plan = plans.get(report.revision) ?? null;
  const diagnostics = [];
  const revisionDir = report.latest?.agentDir ?? null;

  if (report.state !== "available") {
    throw WardrobeError.from(
      `revision ${report.revision} is ${report.state}; it will not be launched`,
      [
        ...(report.recorded !== report.state
          ? [
              new WardrobeDiagnostic({
                path: "/state",
                reason: `the install recorded this revision as ${report.recorded}`,
              }),
            ]
          : []),
        ...report.drift.map(
          (entry) => new WardrobeDiagnostic({ path: `/drift${entry.path}`, reason: entry.detail })
        ),
        ...report.unverified.map(
          (entry) => new WardrobeDiagnostic({ path: "/unverified", reason: entry.reason })
        ),
        ...(report.detail ? [new WardrobeDiagnostic({ path: "", reason: report.detail })] : []),
      ],
      "nothing was started and the revision is left exactly as it was; /wardrobe doctor names the difference"
    );
  }
  if (!plan) {
    throw WardrobeError.from(
      `the approved plan for ${report.revision} is no longer available`,
      [new WardrobeDiagnostic({ path: "/plan", reason: `no stored plan ${report.revision}` })],
      "a revision cannot be launched against a configuration nobody can re-read"
    );
  }

  const sessionDir = sessionDirFor({ revisionDir, explicit: sessionPath, runId });
  const activation = activatedSettingsFor({ plan, inventory: report.latest.installed ?? [] });


  // A requirement the declaration names and this session cannot satisfy is not
  // a warning: the review approved a revision that wanted it, and running
  // without it is a different environment from the one that was approved.
  const unmet = plan.runtime?.tools?.unmet ?? [];
  if (unmet.length > 0) {
    throw WardrobeError.from(
      "this revision cannot meet its own requirements here",
      unmet.map(
        (entry) =>
          new WardrobeDiagnostic({
            path: "/runtime/tools/unmet",
            reason: `${entry.tool}: ${entry.reason}`,
          })
      ),
      "a preset cannot re-enable what the user or CLI excluded; nothing was started"
    );
  }

  // Pi discovers some resources itself, whatever agent directory it was given.
  // Naming them is the difference between a launch that reports its own
  // environment and one that quietly inherits part of someone else's.
  for (const root of externalResourceRoots({ env, cwd })) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path: "/launch/externalResources",
        reason: `Pi will also discover resources at ${root.path} (${root.kind})`,
        hint: "Pi reads these itself; this manager neither copied nor suppressed them, and they are not part of the revision's lock",
      })
    );
  }

  return {
    ok: true,
    diagnostics,
    report,
    plan,
    revisionDir,
    sessionDir,
    activation,
    cli: requireCli(env, agentDir),
    binding: binding ?? null,
    migration: resolved.migration ?? null,
  };
}

/**
 * Observe what the activated revision really loads.
 *
 * This runs after the selection has been written, because observing the
 * settings Pi would have been given anyway would answer a different question.
 * A revision that does not start here is reported rather than handed to a
 * user, and the caller restores what was there.
 */
async function observeSelection({ prepared, env, cwd, managerAgentDir }) {
  const result = await probeLoadedState({
    cli: prepared.cli,
    agentDir: prepared.revisionDir,
    sessionDir: prepared.sessionDir.path,
    // The probe runs inside the revision too, so it needs the same pointer.
    env: { ...env, WARDROBE_AGENT_DIR: managerAgentDir },
    cwd,
  });
  if (!result.ok) {
    throw WardrobeError.from(
      "the revision did not start",
      [
        new WardrobeDiagnostic({ path: "", reason: result.reason ?? "Pi did not answer" }),
        ...(result.stderr
          ? [new WardrobeDiagnostic({ path: "", reason: `Pi said: ${result.stderr.split("\n").slice(-3).join(" ")}` })]
          : []),
      ],
      "the selection was put back as it was; the revision and its record are unchanged"
    );
  }
  const observed = { ...reconcileSelection({ plan: prepared.plan, commands: result.commands }), startup: summariseProbe(result) };
  const diagnostics = [];
  for (const entry of observed.missing) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path: `/resourceSelectors/${entry.package}`,
        reason: `${entry.kind}/${entry.path} was selected but Pi registered nothing for it`,
        hint: "Pi found no resource at the approved path in the installed package",
      })
    );
  }
  for (const entry of observed.collisions) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path: "/launch/collisions",
        reason: `command /${entry.name} is registered by ${entry.registeredBy.length} different resources`,
        hint: entry.registeredBy.map((source) => source.path).filter(Boolean).join(", "),
      })
    );
  }
  for (const entry of observed.unobserved) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path: `/resourceSelectors/${entry.package}`,
        reason: `${entry.kind}/${entry.path} is not observable through commands, so it was not confirmed`,
        hint: "Pi exposes skills and prompts as commands; an extension or theme that registers nothing cannot be seen from here",
      })
    );
  }
  return { observed, diagnostics };
}

/**
 * Launch the revision and wait for it.
 *
 * The lease is taken before anything is written and released when the child
 * ends, however it ends. Signals are forwarded rather than swallowed, so Ctrl-C
 * reaches Pi; the exit status the user sees is Pi's.
 *
 * The selection is written before the probe and before the run, and is put
 * back exactly as it was whenever the launch does not complete. A launch that
 * fails leaves the revision as installed, which is what "prior availability is
 * preserved" has to mean when the only thing a launch changes is a settings
 * file.
 */
export async function runRevision({
  agentDir,
  selector,
  args = [],
  env,
  sessionPath = null,
  cwd = process.cwd(),
  runId = `run-${process.pid}-${Date.now().toString(36)}`,
  stdio = "inherit",
  probe = true,
  resume = null,
}) {
  const bindings = new BindingStore(agentDir);
  const prepared = await preflightLaunch({ agentDir, selector, env, sessionPath, runId, cwd });
  const { report, revisionDir, sessionDir, activation } = prepared;

  const leases = new LeaseStore(agentDir);
  const taken = leases.acquire({
    revision: report.revision,
    kind: "run",
    runId,
    pid: process.pid,
    agentDir: revisionDir,
    command: [prepared.cli, ...args].join(" "),
  });
  if (!taken.granted) {
    throw WardrobeError.from(
      `revision ${report.revision} is already in use`,
      [
        new WardrobeDiagnostic({ path: "/leases", reason: taken.reason }),
        new WardrobeDiagnostic({
          path: "",
          reason: "one revision is one writer; another revision may run at the same time",
        }),
      ],
      "wait for the other process to finish, or launch a different revision"
    );
  }

  // Signals are handled for the whole launch, not only once a child exists: a
  // signal that arrives during preflight has nowhere to forward to, so it is
  // recorded and the launch is refused rather than half-started.
  const forwarded = [];
  let child = null;
  const forward = (signal) => {
    forwarded.push(signal);
    child?.kill(signal);
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  const settingsPath = join(revisionDir, "settings.json");
  const activationText = `${JSON.stringify(activation, null, 2)}\n`;
  const startedAt = new Date().toISOString();
  const diagnostics = [...prepared.diagnostics];
  let previousSettings = null;
  let observed = null;
  let outcome = null;
  let spawnedArgv = null;
  let completed = false;
  // Decided before the lease is taken: a resume path that is not there is a
  // refusal, and refusing before acquiring anything cannot leak it.
  const resuming = sessionArgsFor({ sessionDir, resume });

  try {
    // Both processes the launch owns — the probe and the real run — get a
    // session directory that exists before either starts. A plan that starts
    // nothing never creates one, because creating it would be a side effect of
    // asking a question. Everything from here to the child is inside this try,
    // so the lease is released however this ends.
    prepareSessionDir(sessionDir.path);
    previousSettings = readFileSync(settingsPath, "utf8");
    writeFileSync(settingsPath, activationText);
    // A revision launches carrying the instructions it declared. The settings
    // file is not the place for them: a prompt guideline is contributed by the
    // session, and the session has to be told what this revision asked for
    // before it can contribute anything.
    writeLaunchSession({
      revisionDir,
      report: prepared.report,
      plan: prepared.plan,
      preset: prepared.binding?.preset ?? repositoryKeyOf(prepared.report.preset),
      mode: prepared.binding?.mode ?? "follow",
    });

    // Observe the activated revision in a real process before handing the
    // user's terminal to it. A revision that will not start here is not started
    // at all.
    if (probe) {
      const seen = await observeSelection({ prepared, env, cwd, managerAgentDir: agentDir });
      observed = seen.observed;
      diagnostics.push(...seen.diagnostics);
      const tools = unverifiedTools({ plan: prepared.plan, observed });
      if (tools) {
        diagnostics.push(
          new WardrobeDiagnostic({
            path: "/runtime/tools",
            reason: `tool requirement not verified: ${tools.reason}`,
            hint: tools.detail,
          })
        );
      }
    }
    if (observed && (observed.missing.length > 0 || observed.collisions.length > 0)) {
      throw WardrobeError.from(
        "the revision did not load what was approved",
        diagnostics.filter((entry) => entry.path.startsWith("/resourceSelectors/") || entry.path === "/launch/collisions"),
        "the selection was put back as it was; nothing was launched"
      );
    }
    if (forwarded.length > 0) {
      throw WardrobeError.from(
        "the launch was interrupted before Pi started",
        [
          new WardrobeDiagnostic({
            path: "/launch",
            reason: `received ${forwarded.join(", ")} during preflight`,
          }),
        ],
        "the selection was put back as it was and the lease was released"
      );
    }

    const childArgs = withManagerExtension(withSessionDir([...resuming.args, ...args], sessionDir));
    const [spawnFile, spawnArgs] = dispatchPiCommand(prepared.cli, childArgs);
    spawnedArgv = [prepared.cli, ...childArgs];
    child = spawn(spawnFile, spawnArgs, {
      stdio,
      // Two directories, deliberately: the revision's own is what Pi runs in,
      // and the manager's is where /wardrobe looks for revisions. A session
      // inside a revision without the second pointer would be unmanaged.
      env: { ...env, PI_CODING_AGENT_DIR: revisionDir, WARDROBE_AGENT_DIR: agentDir },
      cwd,
    });
    // The lease names the process it started, so a second launcher can say
    // which Pi is holding the revision rather than only which pid is.
    leases.write({ ...taken.lease, childPid: child.pid });

    outcome = await new Promise((resolve) => {
      child.on("error", (error) => resolve({ code: null, signal: null, error }));
      child.on("close", (code, signal) => resolve({ code, signal, error: null }));
    });
    // A child that never started is not a completed launch: the settings must
    // go back and the claim that nothing changed has to be true.
    if (outcome.error) throw outcome.error;
    completed = true;
  } catch (error) {
    // A launch that did not complete leaves the revision as it was installed.
    if (previousSettings !== null) writeFileSync(settingsPath, previousSettings);
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    if (!completed) leases.release(report.revision, runId);
  }

  const released = leases.release(report.revision, runId);
  const record = {
    runId,
    revision: report.revision,
    kind: "run",
    agentDir: revisionDir,
    sessionDir: sessionDir.path,
    sessionExplicit: sessionDir.explicit,
    resumed: resuming.resumed,
    resumedSession: resuming.path ?? null,
    cwd,
    argv: [prepared.cli, ...args],
    // What Pi was actually started with, which is not the same list: the
    // session directory is made explicit here even when the caller did not
    // name one.
    spawnedArgv,
    env: {
      PI_CODING_AGENT_DIR: revisionDir,
      WARDROBE_AGENT_DIR: agentDir,
    },
    diagnostics: diagnostics.map((entry) => entry.toJSON()),
    observed,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: outcome.code,
    signal: outcome.signal ?? null,
    forwardedSignals: forwarded,
    childPid: child?.pid ?? null,
    settingsChanged: previousSettings !== null && previousSettings !== activationText,
    leaseReleased: released,
    replacedStaleLease: taken.replacedStale ? leaseViewOf(taken.replacedStale) : null,
    // What this launch was supposed to run, and what it moved between. A launch
    // record is coordination for one process, not a durable binding.
    mode: prepared.binding?.mode ?? null,
    binding: prepared.binding ? prepared.binding.preset : null,
    migration: prepared.migration ?? null,
  };
  writeRunRecord(agentDir, record);
  new LaunchRecords(agentDir).write({
    runId: record.runId,
    binding: record.binding,
    mode: record.mode,
    revision: record.revision,
    sessionDir: record.sessionDir,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
  });
  if (prepared.binding && prepared.migration) {
    bindings.write(
      recordMigration(
        bindings.read(prepared.binding.preset) ?? prepared.binding,
        prepared.migration
      )
    );
  }

  return record;
}

/**
 * Keep a record of what each run did.
 *
 * Run records are declared runtime data: they live inside the manager's own
 * directories and are never part of a locked code root, so recording a run
 * cannot invalidate a revision's lock.
 */
function writeRunRecord(agentDir, record) {
  const dir = join(agentDir, "wardrobe", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * This manager's own extension, next to the code that is running it.
 *
 * A revision's agent directory holds the revision and nothing else, so without
 * this the launched process would have no `/wardrobe` at all: a session that
 * cannot be inspected, and cannot adopt a preference, is not the environment
 * the launcher claims to have started. It is a path to the same manager file,
 * not a copy, and it is not part of the revision's locked code.
 */
export function managerExtensionPath() {
  return fileURLToPath(new URL("../extensions/wardrobe.mjs", import.meta.url));
}

/**
 * The child argv with this manager's command present.
 *
 * Extensions are additive, so this is appended rather than swapped in: a
 * caller who passes their own `-e` gets it *and* `/wardrobe`. Skipping the
 * manager whenever any extension was named would leave a launched revision
 * with no command to inspect or reconfigure it with, which is the opposite of
 * what launching one is for.
 */
export function withManagerExtension(args) {
  const path = managerExtensionPath();
  return args.includes(path) ? args : [...args, "--extension", path];
}

/**
 * The child's argv, with the session directory made explicit.
 *
 * Pi keeps its own session store wherever its environment says, so a launch
 * that only set `PI_CODING_AGENT_DIR` would let the child write into whatever
 * session directory it inherited. Naming it here is what makes the record's
 * `sessionDir` a fact about the process rather than an intention. A caller who
 * named one of their own keeps it: `--session` and `--session-dir` are Pi's to
 * resolve, and overriding either would discard a choice the user made.
 */
function withSessionDir(args, sessionDir) {
  const named = args.some((arg) => arg === "--session" || arg.startsWith("--session="));
  if (named || args.includes("--session-dir")) return args;
  return [...args, "--session-dir", sessionDir.path];
}

/**
 * What a launched revision starts with, written beside the revision.
 *
 * This is declared runtime data, not locked code: it records what the revision
 * asked for, so a session can contribute it without re-deriving the plan, and a
 * later preference change is recorded on the session's own branch instead.
 */
function writeLaunchSession({ revisionDir, report, plan, preset, mode }) {
  const dir = join(revisionDir, "wardrobe");
  mkdirSync(dir, { recursive: true });
  const persona = (plan.persona?.append ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.text
  );
  writeFileSync(
    join(dir, "session.json"),
    `${JSON.stringify(
      {
        preset: preset ?? repositoryKeyOf(report.preset),
        mode: mode ?? "follow",
        revision: report.revision,
        // A declaration's persona arrives folded with its provenance; a prompt
        // takes the text.
        persona,
        tools: toolSelectionFor(plan),
        model: plan.runtime?.model?.value ?? null,
        thinking: plan.runtime?.thinking?.value ?? null,
      },
      null,
      2,
    )}\n`
  );
}

/** Create the session directory, or refuse with something a user can act on. */
function prepareSessionDir(path) {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw WardrobeError.from(
      "the session directory cannot be used",
      [
        new WardrobeDiagnostic({ path: "/launch/sessionDir", reason: `${path}: ${error.message}` }),
      ],
      "pass --session <path> naming a writable directory, or omit it to use a session directory inside the revision"
    );
  }
}

function summariseProbe(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    reason: result.reason,
    stderr: result.stderr ? result.stderr.split("\n").slice(-6).join("\n") : null,
  };
}

/**
 * Tool requirements this manager cannot decide on its own.
 *
 * Pi's command surface exposes commands, not tools, so a tool an extension
 * registers cannot be confirmed from here — and Pi itself ignores an unknown
 * name in `defaultTools` without complaining. Rather than report a pass that
 * was never checked, the requirement is reported as unverified and the
 * extensions that were seen loading are named beside it.
 */
function unverifiedTools({ plan, observed }) {
  const wanted = (plan?.runtime?.tools?.enabled ?? [])
    .map((entry) => entry.tool)
    .filter((tool) => !BUILTIN_TOOLS.has(tool));
  if (wanted.length === 0) return null;
  return {
    tools: wanted,
    reason: `${wanted.join(", ")} must be registered by a selected extension; Pi exposes commands rather than tools, so this was not verified here`,
    detail: observed
      ? `extensions seen loading: ${observed.observedLoading.join(", ") || "(none)"}`
      : "no probe ran, so nothing was checked",
  };
}

/**
 * Resource roots Pi discovers outside the revision.
 *
 * Pi reads `~/.agents/skills` and any project `.agents/skills` itself, whatever
 * agent directory it was given. The manager neither copies nor suppresses
 * them, so it names them: a launch that quietly inherited a user's personal
 * skills would be hiding the one thing this process is meant to make visible.
 */
export function externalResourceRoots({ env = {}, cwd = process.cwd() } = {}) {
  const home = env.HOME ?? homedir();
  const roots = [];
  const user = join(home, ".agents", "skills");
  if (existsSync(user)) roots.push({ path: user, kind: "user", owned: false });

  let dir = resolvePath(cwd);
  while (true) {
    const project = join(dir, ".agents", "skills");
    if (existsSync(project)) roots.push({ path: project, kind: "project", owned: false });
    const parsed = parsePath(dir);
    if (dir === parsed.root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

function requireCli(env, agentDir = null) {
  const cli = piCliOf(env, { agentDir });
  if (!cli) {
    throw WardrobeError.from(
      "cannot locate the Pi executable",
      [
        new WardrobeDiagnostic({
          path: "",
          reason: `no Pi CLI at ${env?.WARDROBE_PI_CLI ?? "(none)"}`,
          hint: "set WARDROBE_PI_CLI, ensure pi is on PATH, or integrate with pi --wardrobe",
        }),
      ],
      "a revision is only ever launched by the Pi that verified it"
    );
  }
  return cli;
}

/**
 * The new-process launch plan for `use`.
 *
 * A plan, never a launch: it names what would differ from the user's own
 * baseline, what the command is, and what it will not do. It starts nothing,
 * so it cannot embed another TUI, and it makes no claim about cleaning up
 * extensions that older sessions may have left behind.
 */
export function launchPlanOf({ report, plan, sessionDir, agentDir }) {
  const resources = selectedResourcesOf(plan);
  const packages = (plan.installationSurfaces ?? []).map((surface) => ({
    alias: surface.alias,
    source: surface.source,
    installsCode: surface.installsCode === true,
  }));
  return {
    revision: report.revision,
    preset: report.preset,
    state: report.state,
    lock: report.lock?.digest ?? null,
    launchable: true,
    inProcess: false,
    agentDir: report.latest?.agentDir ?? null,
    sessionDir,
    command: `wardrobe run ${report.revision}${sessionDir?.explicit ? ` --session ${sessionDir.path}` : ""}`,
    managerAgentDir: agentDir ?? null,
    differences: {
      resources: resources.map((entry) => `${entry.kind}:${entry.package}/${entry.path}`),
      packages,
      code: {
        roots: report.lock?.code?.roots ?? [],
        files: report.lock?.code?.files ?? 0,
        packages: Object.keys(report.lock?.code?.packages ?? {}),
      },
      tools: toolSelectionFor(plan),
    },
    // Stated so it is not assumed: nothing here removes anything, and nothing
    // here runs inside the current session.
    doesNot: [
      "run inside this session, or embed another TUI",
      "remove or undo extensions or resources an older session left loaded",
      "change your own agent directory",
    ],
  };
}
