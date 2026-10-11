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
import { execPath } from "node:process";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, resolve as resolvePath } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { piCliOf } from "./lock.mjs";
import { leaseViewOf, LeaseStore } from "./lease.mjs";
import { probeLoadedState, reconcileSelection, selectedResourcesOf } from "./probe.mjs";
import { diagnoseAll, selectRevision } from "./revisions.mjs";

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
 * Decide whether a revision may be launched, and prepare what it would need.
 *
 * This is the half of a launch that answers for itself: the revision still has
 * to measure as its own lock, and the plan it was built from still has to be
 * readable. Whether the resources actually load is a separate question, asked
 * by `observeSelection` once the selection has been written.
 *
 * @returns {Promise<{ok: boolean, diagnostics: WardrobeDiagnostic[],
 *   report: object, plan: object, revisionDir: string, sessionDir: object,
 *   activation: object, cli: string}>}
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
  const report = selectRevision(reports, selector, { unreadable });
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


  // Tools the declaration asked for that this host cannot provide, because the
  // user or the CLI excluded them.
  for (const entry of plan.runtime?.tools?.unmet ?? []) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path: "/runtime/tools/unmet",
        reason: `${entry.tool}: ${entry.reason}`,
        hint: "the launch proceeds without it; a preset cannot re-enable what the user or CLI excluded",
      })
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
    cli: requireCli(env),
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
async function observeSelection({ prepared, env, cwd }) {
  const result = await probeLoadedState({
    cli: prepared.cli,
    agentDir: prepared.revisionDir,
    sessionDir: prepared.sessionDir.path,
    env,
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
}) {
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
  try {
    // Both processes the launch owns — the probe and the real run — get a
    // session directory that exists before either starts. A plan that starts
    // nothing never creates one, because creating it would be a side effect of
    // asking a question. Everything from here to the child is inside this try,
    // so the lease is released however this ends.
    prepareSessionDir(sessionDir.path);
    previousSettings = readFileSync(settingsPath, "utf8");
    writeFileSync(settingsPath, activationText);

    // Observe the activated revision in a real process before handing the
    // user's terminal to it. A revision that will not start here is not started
    // at all.
    if (probe) {
      const seen = await observeSelection({ prepared, env, cwd });
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

    spawnedArgv = [prepared.cli, ...withSessionDir(args, sessionDir)];
    child = spawn(execPath, spawnedArgv, {
      stdio,
      env: { ...env, PI_CODING_AGENT_DIR: revisionDir },
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
    cwd,
    argv: [prepared.cli, ...args],
    // What Pi was actually started with, which is not the same list: the
    // session directory is made explicit here even when the caller did not
    // name one.
    spawnedArgv,
    env: { PI_CODING_AGENT_DIR: revisionDir },
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
  };
  writeRunRecord(agentDir, record);

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

function requireCli(env) {
  const cli = piCliOf(env);
  if (!cli) {
    throw WardrobeError.from(
      "cannot locate the Pi executable",
      [
        new WardrobeDiagnostic({
          path: "",
          reason: `no Pi CLI at ${env?.WARDROBE_PI_CLI ?? process.argv[1] ?? "(none)"}`,
          hint: "set WARDROBE_PI_CLI to the Pi entry point this revision must run through",
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
