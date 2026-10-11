// Launching a verified revision in a real, isolated Pi process.
//
// Every check here starts real Pi processes. The launcher is invoked as the
// standalone command a user would type, and the assertions are made against
// what those processes actually loaded, registered and exited with — not
// against the settings file the manager wrote.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { externalResourceRoots } from "../packages/wardrobe/src/launch.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("isolated-pi-launch");
const MANAGER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages/wardrobe");
const CLI = join(MANAGER_DIR, "bin", "wardrobe.mjs");

/** Cached sources, so each repository is built once per file. */
const repos = {};

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

/** Run one /wardrobe invocation inside a real Pi session and return its result. */
async function wardrobe(h, argument, { extraEnv } = {}) {
  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/`, ...extraEnv },
  });
  try {
    await session.command(`wardrobe ${argument}`);
    const [result] = await session.readCustomEntries(RESULT_TYPE);
    return result.data;
  } finally {
    await session.close();
  }
}

/** The environment every launched process gets: sandboxed, and revision-scoped. */
function launchEnv(h, extra = {}) {
  return h.sandbox.childEnv({
    agentDir: h.agentPath("primary"),
    extra: { WARDROBE_PI_CLI: h.runtime.cliPath, ...extra },
  });
}

/** The agent-directory argument the launcher is pointed at, as a user would. */
function withAgentDir(args, h) {
  return ["--agent-dir", h.agentPath("primary"), ...args];
}

/**
 * Run the standalone launcher, exactly as a user would type it.
 *
 * The harness gives the child no stdin, so a launched Pi sees an ordinary
 * non-interactive invocation and exits on its own. Checks that need to talk to
 * the launched process use `forkLauncher` instead.
 */
function launch(h, args, { cwd, env, timeoutMs } = {}) {
  return h.sandbox.runner.run(process.execPath, [CLI, ...withAgentDir(args, h)], {
    cwd: cwd ?? h.sandbox.project,
    env: launchEnv(h, env),
    timeoutMs,
  });
}

/** Start the launcher with pipes, so a test can speak to the process it starts. */
function forkLauncher(h, args, { cwd } = {}) {
  return h.sandbox.runner.fork(process.execPath, [CLI, ...withAgentDir(args, h)], {
    cwd: cwd ?? h.sandbox.project,
    env: launchEnv(h),
  });
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

/** A preset that selects a skill and an extension the fixture package really ships. */
function fixturePreset(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "launchable",
    name: "Launchable",
    version: "1.0.0",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
    resources: [
      { package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] },
      { package: "tools", kind: "extensions", include: ["extension.mjs"] },
    ],
    ...overrides,
  };
}

async function installPreset(h, name, definition) {
  const git = await repo(h, name, [
    { message: "add", files: { "preset.json": `${JSON.stringify(definition)}\n` } },
  ]);
  const source = git.sourceAt(git.commits[0]);
  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/` },
  });
  let reviewed;
  try {
    await session.command(`wardrobe install ${source}`);
    [reviewed] = await session.readCustomEntries(RESULT_TYPE);
  } finally {
    await session.close();
  }
  assert.equal(reviewed.data.ok, true, reviewed.data.text);
  const confirmed = await wardrobe(h, `install ${source} --confirm ${reviewed.data.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  return { planId: confirmed.plan.planId, agentDir: confirmed.staging.agentDir, source };
}

/**
 * Ask a running RPC process for what it loaded, then let it exit cleanly.
 *
 * Returns the parsed command list, so a test can assert on registration rather
 * than on the settings that were supposed to cause it.
 */
function askAndExit(child, [id = "commands", extra = { type: "get_commands" }] = [], timeoutMs = 60_000) {
  let buffer = "";
  const rows = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Not a protocol record; stderr is where diagnostics belong.
      }
    }
  });
  child.stdin.write(`${JSON.stringify({ id, ...extra })}\n`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ rows, timedOut: true });
    }, timeoutMs);
    const check = setInterval(() => {
      const row = rows.find((entry) => entry.id === id && entry.type === "response");
      if (!row) return;
      clearInterval(check);
      clearTimeout(timer);
      child.stdin.end();
      resolve({ row, rows, timedOut: false });
    }, 50);
  });
}

/**
 * The newest run record for one revision.
 *
 * The agent directory is shared across this file, so a record is only ever read
 * for the revision a check is about.
 */
function runRecord(h, agentDir, revision) {
  const dir = join(agentDir, "wardrobe", "runs");
  if (!existsSync(dir)) return null;
  // Run ids embed a pid, so file order is not chronological; the records
  // themselves say when each run started.
  const records = readdirSync(dir)
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")))
    .filter((record) => !revision || record.revision === revision)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return records.at(-1) ?? null;
}

function settingsOf(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

test("a launch makes the approved selection load through Pi's own mechanisms", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(h, "launch-basic", fixturePreset());

  // Before the launch the staged revision has nothing selected, exactly as it
  // was installed.
  assert.deepEqual(settingsOf(revisionDir).packages[0].extensions, []);
  assert.deepEqual(settingsOf(revisionDir).packages[0].skills, []);

  const child = forkLauncher(h, ["run", planId, "--", "--mode", "rpc", "--no-session"]);
  const { row, timedOut } = await askAndExit(child);
  assert.equal(timedOut, false, "the launched process never answered");
  assert.equal(row.success, true, JSON.stringify(row).slice(0, 300));

  const commands = row.data.commands;
  const extension = commands.find((entry) => entry.name === "fixture-only");
  const skill = commands.find((entry) => entry.name === "skill:fixture-review");
  assert.ok(extension, `the selected extension did not register: ${commands.map((c) => c.name).join(", ")}`);
  assert.ok(skill, `the selected skill did not register: ${commands.map((c) => c.name).join(", ")}`);
  // Both came from inside the revision's own directory, which is what makes
  // this a launch of that revision rather than of the current environment.
  assert.ok(
    extension.sourceInfo.path.startsWith(revisionDir),
    `the command came from ${extension.sourceInfo.path}, outside the revision`
  );
  assert.ok(skill.sourceInfo.path.startsWith(revisionDir), `the skill came from ${skill.sourceInfo.path}`);

  const exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  assert.equal(exit, 0, "a clean run of a verified revision did not exit 0");

  const settings = settingsOf(revisionDir);
  assert.deepEqual(settings.packages[0].extensions, ["extension.mjs"]);
  assert.deepEqual(settings.packages[0].skills, ["skills/review/SKILL.md"]);
  assert.deepEqual(settings.packages[0].prompts, []);
  assert.deepEqual(settings.packages[0].themes, []);

  const record = runRecord(h, h.agentPath("primary"), planId);
  assert.equal(record.revision, planId);
  assert.equal(record.agentDir, revisionDir);
  assert.equal(record.exitCode, 0);
  assert.equal(record.leaseReleased, true);
  assert.ok(record.sessionDir.startsWith(revisionDir), `session dir ${record.sessionDir} escaped the revision`);
  assert.equal(record.sessionExplicit, false);
  assert.deepEqual(record.observed.missing, []);
  assert.deepEqual(record.observed.collisions, []);
  assert.deepEqual(
    record.observed.observedLoading,
    ["extension.mjs"],
    "the selected extension was not seen loading"
  );
  h.record("launch-loads-approved-selection", {
    revision: planId,
    agentDir: revisionDir,
    extensionCommand: extension.sourceInfo.path,
    skillCommand: skill.sourceInfo.path,
    exitCode: record.exitCode,
    sessionDir: record.sessionDir,
    observed: record.observed.observedLoading,
  });
});

test("a launch is isolated: the user's own directory, auth and sessions are untouched", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(h, "launch-isolation", fixturePreset());
  const userDir = h.agentPath("primary");
  const before = h.snapshotAgent("primary");
  const beforeFiles = readdirSync(userDir).sort();

  const result = await launch(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

  assert.deepEqual(h.snapshotAgent("primary"), before, "the user's own agent directory changed");
  assert.deepEqual(readdirSync(userDir).sort(), beforeFiles, "the user's agent directory gained files");
  // Pi creates its own empty credential store in any agent directory it is
  // given. What must not happen is the user's credential file arriving there,
  // so the content is compared rather than the presence of the file.
  const userAuth = readFileSync(join(userDir, "auth.json"));
  const revisionAuth = readFileSync(join(revisionDir, "auth.json"), "utf8");
  assert.ok(!revisionAuth.includes(userAuth.toString().trim().slice(1, 40)), "the user's auth.json reached the revision");

  const record = runRecord(h, userDir);
  assert.equal(record.env.PI_CODING_AGENT_DIR, revisionDir);
  assert.notEqual(record.agentDir, userDir);
  assert.ok(
    record.sessionDir.startsWith(revisionDir),
    `the session directory ${record.sessionDir} is not the revision's own`
  );
  // Nothing was copied or linked: the only credential-shaped file in the
  // revision is the empty store Pi itself creates, and no registry
  // configuration arrived with it.
  assert.deepEqual(
    readdirSync(revisionDir).filter((entry) => [".npmrc", ".netrc", "credentials.json"].includes(entry)),
    [],
    "credential configuration appeared in the revision"
  );
  assert.deepEqual(JSON.parse(revisionAuth), {}, "the revision's credential store is not empty");
  h.record("launch-is-isolated", {
    revisionDir,
    userDirUnchanged: true,
    unchangedTopLevel: beforeFiles,
    authInRevision: false,
    sessionDir: record.sessionDir,
  });
});

test("a second run of one revision is refused; another revision runs at the same time", async () => {
  const h = harness();
  await installManager(h);
  const first = await installPreset(h, "launch-busy-a", fixturePreset({ id: "busy-a", name: "Busy A" }));
  const second = await installPreset(h, "launch-busy-b", fixturePreset({ id: "busy-b", name: "Busy B" }));

  const live = forkLauncher(h, ["run", first.planId, "--", "--mode", "rpc", "--no-session"]);
  // Wait until the lease is actually held, rather than racing the launcher.
  const leaseDir = join(h.agentPath("primary"), "wardrobe", "leases");
  const held = await waitFor(() => existsSync(join(leaseDir, `${first.planId}.json`)), 60_000);
  assert.equal(held, true, "the first run never took its lease");

  const lease = JSON.parse(readFileSync(join(leaseDir, `${first.planId}.json`), "utf8"));
  assert.equal(lease.revision, first.planId);
  assert.equal(lease.kind, "run");
  assert.equal(lease.pid, live.pid);
  assert.equal(lease.agentDir, first.agentDir);

  const refused = await launch(h, ["run", first.planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.notEqual(refused.code, 0, "a second run of a busy revision was allowed");
  assert.match(refused.stderr, /already in use/);
  assert.match(refused.stderr, new RegExp(`run pid ${live.pid}`));
  assert.match(refused.stderr, /one revision is one writer/);

  // A different revision is a different directory, and runs independently.
  const other = await launch(h, ["run", second.planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.equal(other.code, 0, `${other.stderr}\n${other.stdout}`);

  live.stdin.end();
  const exited = await new Promise((resolve) => live.on("close", (code) => resolve(code)));
  assert.equal(exited, 0);
  assert.equal(
    existsSync(join(leaseDir, `${first.planId}.json`)),
    false,
    "the lease outlived an orderly exit"
  );
  assert.equal(
    existsSync(join(leaseDir, `${second.planId}.json`)),
    false,
    "the second revision's lease outlived its exit"
  );
  h.record("second-run-refused", {
    refusedExit: refused.code,
    refusal: refused.stderr.split("\n")[0],
    holder: { pid: lease.pid, kind: lease.kind },
    concurrentRevisionExit: other.code,
    leasesReleased: true,
  });
});

test("stale ownership is diagnosed and replaced; live ownership is never taken", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(h, "launch-lease", fixturePreset());
  const leases = join(h.agentPath("primary"), "wardrobe", "leases");

  // A lease whose process is gone is stale ownership: it is reported and
  // replaced, not obeyed.
  const dead = spawnExitAndWait();
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    join(leases, `${planId}.json`),
    `${JSON.stringify({ revision: planId, kind: "run", runId: "run-gone", pid: dead, host: "localhost", startedAt: "2020-01-01T00:00:00.000Z" }, null, 2)}\n`
  );

  const result = await launch(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const record = runRecord(h, h.agentPath("primary"), planId);
  assert.ok(record.replacedStaleLease, "a stale lease was not reported as replaced");
  assert.equal(record.replacedStaleLease.pid, dead);
  assert.equal(record.replacedStaleLease.stale, true);
  assert.equal(record.replacedStaleLease.alive, false);
  assert.equal(record.agentDir, revisionDir);

  // A lease this very process holds is live, and is refused.
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    join(leases, `${planId}.json`),
    `${JSON.stringify({ revision: planId, kind: "run", runId: "run-live", pid: process.pid, host: "localhost", startedAt: new Date().toISOString() }, null, 2)}\n`
  );
  const refused = await launch(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.notEqual(refused.code, 0, "a live lease was taken anyway");
  assert.match(refused.stderr, /already in use/);
  assert.match(refused.stderr, new RegExp(`run pid ${process.pid}`));
  // And the live lease is exactly as it was: nothing stole it.
  const still = JSON.parse(readFileSync(join(leases, `${planId}.json`), "utf8"));
  assert.equal(still.runId, "run-live");
  h.record("lease-ownership", {
    stalePid: dead,
    staleReplaced: record.replacedStaleLease,
    livePid: process.pid,
    liveRefusal: refused.stderr.split("\n")[0],
    liveLeaseUnchanged: still.runId,
  });
});

test("child working directory, arguments and exit status are the child's", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(h, "launch-child", fixturePreset());
  const elsewhere = join(h.sandbox.root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });

  // An option Pi does not know fails in Pi, not in the manager.
  const failed = await launch(h, ["run", planId, "--", "--no-such-option"], { timeoutMs: 120_000 });
  assert.notEqual(failed.code, 0, "a failing child produced a successful exit");
  const failedRecord = runRecord(h, h.agentPath("primary"), planId);
  assert.notEqual(failedRecord.exitCode, 0, "the child's exit status was not recorded");
  assert.equal(failedRecord.leaseReleased, true, "a failed child kept the lease");

  // Arguments after `--` reach the child unchanged, and the child runs in the
  // directory the launcher was started in. Both are observed by asking the
  // launched process itself.
  const asked = forkLauncher(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    cwd: elsewhere,
  });
  const { row: where, timedOut: whereTimedOut } = await askAndExit(
    asked,
    ["p", { type: "bash", command: "pwd" }],
    60_000
  );
  assert.equal(whereTimedOut, false, "the launched process never answered");
  assert.equal(where.success, true, JSON.stringify(where).slice(0, 300));
  assert.ok(
    JSON.stringify(where.data).includes(realpathSync(elsewhere)),
    `the child did not run in ${elsewhere}: ${JSON.stringify(where.data).slice(0, 400)}`
  );
  const askedExit = await new Promise((resolve) => asked.on("close", resolve));
  assert.equal(askedExit, 0);
  const record = runRecord(h, h.agentPath("primary"), planId);
  assert.equal(realpathSync(record.cwd), realpathSync(elsewhere), "the run record does not name the working directory");
  assert.deepEqual(record.argv.slice(1), ["--mode", "rpc", "--no-session"]);

  // A signal is forwarded, not swallowed, and the launcher still ends cleanly.
  const signalled = forkLauncher(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    cwd: elsewhere,
  });
  // Wait until the lease names a Pi process, so the signal has a child to
  // reach rather than landing during preflight.
  const leasePath = join(h.agentPath("primary"), "wardrobe", "leases", `${planId}.json`);
  assert.equal(
    await waitFor(() => existsSync(leasePath) && JSON.parse(readFileSync(leasePath, "utf8")).childPid, 60_000),
    true,
    "the signalled run never started Pi"
  );
  const heldChild = JSON.parse(readFileSync(leasePath, "utf8")).childPid;
  signalled.kill("SIGINT");
  const signalledExit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signalled.kill("SIGKILL");
      resolve("timeout");
    }, 30_000);
    signalled.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.notEqual(signalledExit, "timeout", "the launcher did not end after a signal");
  const signalledRecord = runRecord(h, h.agentPath("primary"), planId);
  assert.deepEqual(signalledRecord.forwardedSignals, ["SIGINT"], "the signal was not forwarded to Pi");
  assert.equal(signalledRecord.childPid, heldChild, "the record names a different Pi process");
  assert.notEqual(signalledRecord.signal, null, "Pi was not reported as signalled");
  assert.equal(signalledRecord.leaseReleased, true, "a signalled run kept its lease");
  assert.equal(existsSync(leasePath), false, "a signalled run left its lease behind");
  assert.ok(revisionDir.startsWith(h.agentPath("primary")));
  h.record("child-lifecycle", {
    failingChildExit: failed.code,
    recordedExit: failedRecord.exitCode,
    cwd: record.cwd,
    argv: record.argv.slice(1),
    signalledExit,
    forwardedSignals: signalledRecord.forwardedSignals,
    leaseReleased: signalledRecord.leaseReleased,
  });
});

test("a refused launch leaves the revision exactly as it was", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(h, "launch-drift", fixturePreset());
  const packageDir = join(revisionDir, "npm", "node_modules", "wardrobe-fixture");
  writeFileSync(join(packageDir, "extension.mjs"), "export default function () { return 5; }\n");
  const driftedBytes = readFileSync(join(packageDir, "extension.mjs"), "utf8");
  const settingsBefore = readFileSync(join(revisionDir, "settings.json"), "utf8");

  const refused = await launch(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.notEqual(refused.code, 0, "a drifted revision was launched");
  assert.match(refused.stderr, /will not be launched/);
  assert.match(refused.stderr, /\/drift\/lock\/code/);
  assert.equal(
    existsSync(join(h.agentPath("primary"), "wardrobe", "leases", `${planId}.json`)),
    false,
    "a refused launch took a lease"
  );
  assert.equal(runRecord(h, h.agentPath("primary"), planId), null, "a refused launch wrote a run record");
  assert.equal(
    readFileSync(join(packageDir, "extension.mjs"), "utf8"),
    driftedBytes,
    "the refusal changed the drifted tree"
  );
  assert.equal(
    readFileSync(join(revisionDir, "settings.json"), "utf8"),
    settingsBefore,
    "the refusal activated the selection anyway"
  );
  // The revision is still reported as what it is, not as healthy.
  const status = await wardrobe(h, `status ${planId}`);
  assert.equal(status.state, "drifted");
  assert.equal(status.selected.recorded, "available");
  h.record("refused-launch-preserves-revision", {
    exit: refused.code,
    refusal: refused.stderr.split("\n").slice(0, 3),
    leaseTaken: false,
    runRecordWritten: false,
    stateAfter: status.state,
  });
});

test("use emits a launch plan, starts nothing, and refuses while a revision is busy", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(
    h,
    "launch-use",
    fixturePreset({ runtime: { tools: { enable: ["bash"], disable: ["edit"] }, thinking: "high" } })
  );

  const planned = await wardrobe(h, `use ${planId}`);
  assert.equal(planned.ok, true, planned.text);
  assert.equal(planned.launchPlan.inProcess, false);
  assert.equal(planned.launchPlan.revision, planId);
  assert.equal(planned.launchPlan.agentDir, revisionDir);
  assert.deepEqual(planned.launchPlan.differences.resources, [
    "extensions:tools/extension.mjs",
    "skills:tools/skills/review/SKILL.md",
  ]);
  assert.deepEqual(
    planned.launchPlan.differences.packages.map((entry) => entry.source),
    ["npm:wardrobe-fixture@1.0.0"]
  );
  assert.deepEqual(planned.launchPlan.differences.tools, ["+bash", "-edit"]);
  assert.ok(planned.launchPlan.differences.code.files > 0);
  assert.match(planned.launchPlan.command, new RegExp(`wardrobe run ${planId}`));
  assert.match(planned.text, /nothing was started/);
  assert.match(planned.text, /embed another TUI/);
  assert.match(planned.text, /older session left loaded/);
  assert.equal(runRecord(h, h.agentPath("primary"), planId), null, "use started something");

  // The same plan from the standalone command, as a user would run it.
  const cliPlan = await launch(h, ["use", planId], { timeoutMs: 120_000 });
  assert.equal(cliPlan.code, 0, cliPlan.stderr);
  const parsed = JSON.parse(cliPlan.stdout);
  assert.equal(parsed.revision, planId);
  assert.equal(parsed.inProcess, false);

  // While a run holds the revision, there is no plan to give.
  const live = forkLauncher(h, ["run", planId, "--", "--mode", "rpc", "--no-session"]);
  const leaseDir = join(h.agentPath("primary"), "wardrobe", "leases");
  assert.equal(await waitFor(() => existsSync(join(leaseDir, `${planId}.json`)), 60_000), true);

  const busy = await wardrobe(h, `use ${planId}`);
  assert.equal(busy.ok, false);
  assert.match(busy.text, /is busy/);
  assert.match(busy.text, new RegExp(`run pid ${live.pid}`));
  const busyCli = await launch(h, ["use", planId], { timeoutMs: 120_000 });
  assert.notEqual(busyCli.code, 0, "the CLI planned a launch for a busy revision");

  live.stdin.end();
  await new Promise((resolve) => live.on("close", resolve));
  h.record("use-launch-plan", {
    revision: planId,
    resources: planned.launchPlan.differences.resources,
    tools: planned.launchPlan.differences.tools,
    command: planned.launchPlan.command,
    startedNothing: true,
    busyRefusal: busy.text.split("\n")[0],
  });
});

test("the child is told which session directory to use", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(h, "launch-sessdir", fixturePreset());
  const sharedSessions = h.sandbox.sessions;
  const sharedBefore = readdirSync(sharedSessions).sort();

  const asked = forkLauncher(h, ["run", planId, "--", "--mode", "rpc", "--no-session"]);
  const { row, timedOut } = await askAndExit(asked);
  assert.equal(timedOut, false, "the launched process never answered");
  assert.equal(row.success, true, JSON.stringify(row).slice(0, 300));
  assert.equal(await new Promise((resolve) => asked.on("close", resolve)), 0);

  const record = runRecord(h, h.agentPath("primary"), planId);
  assert.ok(record.sessionDir.startsWith(revisionDir), `the session directory ${record.sessionDir} escaped the revision`);
  assert.ok(existsSync(record.sessionDir), "the named session directory was never created");
  // Pi keeps its session store wherever its environment says. The launcher's
  // explicit directory is what decides, and the record says what Pi was actually
  // started with rather than what the caller asked for.
  assert.deepEqual(record.argv.slice(1), ["--mode", "rpc", "--no-session"]);
  assert.deepEqual(record.spawnedArgv.slice(1), [
    "--mode",
    "rpc",
    "--no-session",
    "--session-dir",
    record.sessionDir,
  ]);
  assert.deepEqual(record.env, { PI_CODING_AGENT_DIR: revisionDir });
  assert.deepEqual(readdirSync(sharedSessions).sort(), sharedBefore, "the shared session store was touched");

  // A caller who names their own session directory keeps it: the launcher does
  // not override a choice Pi would resolve itself.
  const mine = join(h.sandbox.root, "my-sessions");
  const own = forkLauncher(h, ["run", planId, "--session", mine, "--", "--mode", "rpc", "--no-session"]);
  const { row: ownRow, timedOut: ownTimedOut } = await askAndExit(own);
  assert.equal(ownTimedOut, false);
  assert.equal(ownRow.success, true);
  assert.equal(await new Promise((resolve) => own.on("close", resolve)), 0);
  const ownRecord = runRecord(h, h.agentPath("primary"), planId);
  assert.equal(ownRecord.sessionDir, mine);
  assert.equal(ownRecord.sessionExplicit, true);
  // The launcher's `--session` names a directory, which Pi takes as
  // `--session-dir`; the caller's choice is what Pi is given.
  assert.deepEqual(ownRecord.spawnedArgv.slice(-2), ["--session-dir", mine]);
  h.record("explicit-session-directory", {
    revisionSessionDir: record.sessionDir,
    argv: record.argv.slice(1),
    spawnedArgv: record.spawnedArgv.slice(1),
    sharedStoreUnchanged: true,
    chosenSessionDir: mine,
  });
});

test("a lease that cannot be read is treated as held, not absent", async () => {
  const h = harness();
  await installManager(h);
  const { planId } = await installPreset(h, "launch-badlease", fixturePreset());
  const leasePath = join(h.agentPath("primary"), "wardrobe", "leases", `${planId}.json`);
  mkdirSync(join(h.agentPath("primary"), "wardrobe", "leases"), { recursive: true });
  writeFileSync(leasePath, "{ this is not json");

  // A plan for a revision whose ownership cannot be established is refused.
  const refused = await launch(h, ["use", planId], { timeoutMs: 120_000 });
  assert.notEqual(refused.code, 0, "an unreadable lease was treated as no lease");
  assert.match(refused.stderr, /is busy/);
  assert.match(refused.stderr, /unreadable/);

  // And a run is refused too: acquire already refuses, and it refuses the same
  // way `use` now does.
  const run = await launch(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.notEqual(run.code, 0, "a run took a revision with an unreadable lease");
  assert.match(run.stderr, /already in use/);
  assert.match(run.stderr, /unreadable/);
  assert.equal(readFileSync(leasePath, "utf8"), "{ this is not json", "the unreadable lease was overwritten");
  h.record("unreadable-lease-is-held", {
    planRefusal: refused.stderr.split("\n")[0],
    runRefusal: run.stderr.split("\n")[0],
    leaseUnchanged: true,
  });
});

test("the launcher refuses to guess which agent directory it means", async () => {
  const h = harness();
  await installManager(h);
  const { planId } = await installPreset(h, "launch-noagentdir", fixturePreset());

  // PI_CODING_AGENT_DIR is inherited by every process Pi starts. Accepting it
  // would mean launching into a caller's own environment whenever the launcher
  // ran from inside a session, so it is never used.
  const inherited = await h.sandbox.runner.run(process.execPath, [CLI, "run", planId], {
    cwd: h.sandbox.project,
    env: launchEnv(h),
    timeoutMs: 60_000,
  });
  assert.equal(inherited.code, 2);
  assert.match(inherited.stderr, /needs to be told which agent directory/);
  assert.match(inherited.stderr, /PI_CODING_AGENT_DIR is not used/);
  assert.equal(
    runRecord(h, h.agentPath("primary"), planId),
    null,
    "a refused launcher started something"
  );

  // Naming it works, and `use` — which starts nothing — needs it named too.
  const named = await launch(h, ["use", planId], { timeoutMs: 120_000 });
  assert.equal(named.code, 0, named.stderr);
  assert.equal(JSON.parse(named.stdout).revision, planId);
  h.record("launcher-needs-an-explicit-agent-dir", {
    inheritedExit: inherited.code,
    refusal: inherited.stderr.split("\n")[0],
    namedExit: named.code,
  });
});

test("resource roots Pi discovers outside the revision are named, not hidden", async () => {
  const h = harness();
  await installManager(h);
  const { planId } = await installPreset(h, "launch-external", fixturePreset());

  // A user-level Agent Skills directory Pi reads itself, whatever agent
  // directory it was given.
  const userSkills = join(h.sandbox.home, ".agents", "skills", "personal");
  mkdirSync(userSkills, { recursive: true });
  writeFileSync(
    join(userSkills, "SKILL.md"),
    "---\nname: personal-skill\ndescription: a personal skill\n---\n\n# personal\n"
  );

  const roots = externalResourceRoots({ env: launchEnv(h), cwd: h.sandbox.project });
  assert.ok(
    roots.some((entry) => entry.path === join(h.sandbox.home, ".agents", "skills")),
    `the personal skills root was not found: ${JSON.stringify(roots)}`
  );
  assert.ok(roots.every((entry) => entry.owned === false), "an external root was claimed as owned");

  const planned = await wardrobe(h, `use ${planId}`);
  const named = planned.diagnostics.find((entry) => entry.reason.includes(".agents"));
  assert.ok(named, `the launch plan hid an external resource root: ${JSON.stringify(planned.diagnostics)}`);
  assert.match(named.hint, /neither copied nor suppressed/);

  // And it really does load: the launch names it rather than pretending the
  // revision is the whole environment.
  const result = await launch(h, ["run", planId, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const record = runRecord(h, h.agentPath("primary"), planId);
  assert.ok(
    record.diagnostics.some((entry) => entry.reason.includes(".agents")),
    "the launch record did not name the external resource root"
  );
  h.record("external-resource-roots", {
    roots,
    planDiagnostic: named.reason,
    runDiagnostic: record.diagnostics.find((entry) => entry.reason.includes(".agents")).reason,
  });
});

test("an unusable session directory is refused before anything starts", async () => {
  const h = harness();
  await installManager(h);
  const { planId, agentDir: revisionDir } = await installPreset(h, "launch-session", fixturePreset());
  const settingsBefore = readFileSync(join(revisionDir, "settings.json"), "utf8");
  // A path that is a file, where a session directory has to be.
  const blocked = join(h.sandbox.root, "not-a-directory");
  writeFileSync(blocked, "this is a file\n");

  const failed = await launch(h, ["run", planId, "--session", blocked, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.notEqual(failed.code, 0, "a launch with an unusable session directory appeared to succeed");
  assert.match(failed.stderr, /the session directory cannot be used/);
  assert.match(failed.stderr, /--session <path> naming a writable directory/);
  assert.equal(
    existsSync(join(h.agentPath("primary"), "wardrobe", "leases", `${planId}.json`)),
    false,
    "a refused launch left a lease behind"
  );
  assert.equal(
    readFileSync(join(revisionDir, "settings.json"), "utf8"),
    settingsBefore,
    "a refused launch activated the selection anyway"
  );

  // And the revision is still the same verified revision afterwards.
  const status = await wardrobe(h, `status ${planId}`);
  assert.equal(status.state, "available", JSON.stringify(status.selected));
  rmSync(blocked, { force: true });
  h.record("unusable-session-directory", {
    exit: failed.code,
    sessionDir: blocked,
    refusal: failed.stderr.split("\n")[0],
    leaseTaken: false,
    settingsChanged: false,
    revisionStateAfter: status.state,
  });
});

/** Wait for a condition, polling; returns whether it became true in time. */
async function waitFor(predicate, timeoutMs, everyMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return predicate();
}

/** A pid that is guaranteed to have exited: a child that finished on its own. */
function spawnExitAndWait() {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
}
