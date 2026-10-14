// Binding a preset to a mode, and resuming a real conversation.
//
// Every check here starts real Pi processes through the launcher and reads what
// they actually did: which revision ran, what a binding resolved to, what a
// resumed session recovered, and what a migration recorded. A turn is completed
// against the fixtures' local provider, so nothing here needs a credential or a
// network.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { launchEnv, useHarness } from "./support/harness.mjs";

const harness = useHarness("bindings-resume");
const MANAGER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages/wardrobe");
const CLI = join(MANAGER_DIR, "bin", "wardrobe.mjs");

/** Cached sources, so each repository is built once per file. */
const repos = {};

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

async function wardrobe(h, argument) {
  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/` },
  });
  try {
    await session.command(`wardrobe ${argument}`);
    const [result] = await session.readCustomEntries(RESULT_TYPE);
    return result.data;
  } finally {
    await session.close();
  }
}

/** Review and install a source; returns the install result. */
async function installSource(h, source) {
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  const confirmed = await wardrobe(h, `install ${source} --confirm ${reviewed.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  return confirmed;
}

/**
 * One source with three approved revisions.
 *
 * Versions deliberately run against approval order: the third commit declares
 * a *lower* version than the second, so a follow that ordered by a version
 * label would pick differently from one that orders by approval.
 */
async function approvedRevisions(h, { name, id = "bound", thinking = ["low", "high", "medium"] }) {
  const git = await repo(h, name, [
    {
      message: "first",
      files: {
        "preset.json": `${JSON.stringify({
          schemaVersion: 1,
          id,
          name: "Bound",
          version: "1.0.0",
          compatibility: { pi: ">=1.1.0 <2.0.0" },
          packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
          resources: [{ package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] }],
          runtime: { thinking: thinking[0] },
        })}\n`,
      },
    },
    {
      message: "second",
      files: {
        "preset.json": `${JSON.stringify({
          schemaVersion: 1,
          id,
          name: "Bound",
          version: "2.0.0",
          compatibility: { pi: ">=1.1.0 <2.0.0" },
          packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
          resources: [{ package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] }],
          runtime: { thinking: thinking[1] },
        })}\n`,
      },
    },
    {
      message: "third",
      files: {
        "preset.json": `${JSON.stringify({
          schemaVersion: 1,
          id,
          name: "Bound",
          version: "0.9.0",
          compatibility: { pi: ">=1.1.0 <2.0.0" },
          packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
          resources: [{ package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] }],
          runtime: { thinking: thinking[2] },
        })}\n`,
      },
    },
  ]);
  return {
    first: git.sourceAt(git.commits[0]),
    second: git.sourceAt(git.commits[1]),
    third: git.sourceAt(git.commits[2]),
  };
}

/**
 * Run the launcher and speak Pi's protocol to the process it starts.
 *
 * Returns the run record and what the session reported, so a check can assert
 * on both what was asked for and what happened.
 */
async function launched(h, target, { args = [], extraArgs = [], launcherArgs = [], persist = false } = {}) {
  const child = h.sandbox.runner.fork(
    process.execPath,
    [
      CLI,
      "--agent-dir",
      h.agentPath("primary"),
      "run",
      target,
      // Wardrobe's own options come before the separator; everything after it
      // is Pi's, unchanged.
      ...launcherArgs,
      "--",
      "--mode",
      "rpc",
      // A persisted session is a different process from an in-memory one, and
      // which one is under test changes what is written.
      ...(persist ? [] : ["--no-session"]),
      "--extension",
      h.pi.ensureDriver(),
      ...extraArgs,
    ],
    { cwd: h.sandbox.project, env: launchEnv(h) }
  );

  let buffer = "";
  let stderr = "";
  const rows = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
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
        // Not a protocol record.
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));

  let seq = 0;
  const send = (type, extra = {}) =>
    new Promise((resolve) => {
      const id = `probe-${++seq}`;
      const started = Date.now();
      const poll = setInterval(() => {
        const row = rows.find((entry) => entry.id === id && entry.type === "response");
        if (!row && Date.now() - started < 25_000) return;
        clearInterval(poll);
        resolve(row ?? null);
      }, 40);
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });

  const waitForCommands = async (expected, timeoutMs = 25_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = await send("get_commands");
      const names = (row?.data?.commands ?? []).map((command) => command.name);
      if (expected.every((name) => names.includes(name))) return names;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the session never registered ${expected.join(", ")}\n${stderr.slice(0, 600)}`);
  };

  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    child.stdin.end();
    const code = await new Promise((resolve) => child.on("close", resolve));
    h.sandbox.runner.release(child);
    return code;
  };

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    h.sandbox.runner.release(child);
  };

  return { child, send, waitForCommands, close, kill, stderr: () => stderr, args };
}

function runRecords(h) {
  const dir = join(h.agentPath("primary"), "wardrobe", "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function latestRun(h) {
  const all = runRecords(h);
  return all.at(-1) ?? null;
}

function stateOf(revisionDir) {
  const path = join(revisionDir, "fixture-state.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

function requestOf(revisionDir) {
  const path = join(revisionDir, "fixture-request.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

async function waitFor(path, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("follow runs the newest approved revision and records the migration", async (t) => {
  const h = harness();
  await installManager(h);
  const presetKey = "following";
  const pair = await approvedRevisions(h, { name: "bind-follow", id: presetKey });
  const one = await installSource(h, pair.first);
  const two = await installSource(h, pair.second);
  const three = await installSource(h, pair.third);
  assert.notEqual(one.plan.planId, two.plan.planId);

  const bound = await wardrobe(h, `bind ${presetKey} --mode follow`);
  assert.equal(bound.ok, true, `bind refused: ${JSON.stringify(bound).slice(0, 600)}`);
  assert.equal(bound.binding.mode, "follow", JSON.stringify(bound).slice(0, 400));
  // Recorded canonically, not as the short key that was typed.
  const canonical = bound.binding.preset;
  assert.notEqual(canonical, presetKey);
  assert.ok(canonical.endsWith(`#${presetKey}`), canonical);
  assert.equal(bound.binding.durable, true);
  // The third commit declares 0.9.0, below the second's 2.0.0: approval order,
  // not a version label, decides.
  assert.equal(bound.resolves.revision, three.plan.planId, JSON.stringify(bound.resolves));

  const first = await launched(h, presetKey);
  t.after(() => first.kill());
  await first.waitForCommands(["fixture-state", "wardrobe"]);
  const picked = await first.send("prompt", { message: "/fixture-use-local" });
  assert.equal(picked?.success, true, JSON.stringify(picked));
  await first.send("prompt", { message: "/fixture-state" });
  assert.equal(await first.close(), 0);

  const run = latestRun(h);
  assert.equal(run.revision, three.plan.planId, "follow did not run the newest approved revision");
  assert.equal(run.mode, "follow");
  assert.equal(run.binding, canonical, "the run did not name the binding it followed");

  const status = await wardrobe(h, "bind");
  assert.equal(status.ok, true, status.text);
  assert.equal(status.state, "bound");
  assert.equal(status.bindings[0].lastLaunched, three.plan.planId);
  assert.match(status.text, /last launch: revision/);
  h.record("follow-runs-newest-approved", {
    versions: ["1.0.0", "2.0.0", "0.9.0"],
    chosen: run.revision,
    approvalOrder: [one.plan.planId, two.plan.planId, three.plan.planId],
    lastLaunched: status.bindings[0].lastLaunched,
  });
});

test("a follow migration records both revisions and changes nothing retroactively", async (t) => {
  const h = harness();
  await installManager(h);
  const presetKey = "migrating";
  const pair = await approvedRevisions(h, { name: "bind-migrate", id: presetKey });
  const first = await installSource(h, pair.first);
  const bound = await wardrobe(h, `bind ${presetKey} --mode follow`);
  const canonical = bound.binding.preset;

  const session = await launched(h, presetKey);
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.close();
  const before = latestRun(h);
  assert.equal(before.revision, first.plan.planId);

  // A newer revision is approved after the session has already run once.
  const second = await installSource(h, pair.second);
  const migrated = await launched(h, presetKey);
  t.after(() => migrated.kill());
  await migrated.waitForCommands(["fixture-state", "wardrobe"]);
  await migrated.send("prompt", { message: "/fixture-use-local" });
  await migrated.send("prompt", { message: "/fixture-state" });
  await migrated.close();

  const after = latestRun(h);
  assert.equal(after.revision, second.plan.planId, "follow did not move to the newer approval");
  assert.ok(after.migration, "no migration was recorded");
  assert.equal(after.migration.from, first.plan.planId);
  assert.equal(after.migration.to, second.plan.planId);
  assert.match(after.migration.reason, /newest approved available revision/);

  // The earlier revision is untouched and still verifies: history is recorded,
  // not rewritten.
  const earlier = await diagnoseThrough(h, first.plan.planId);
  assert.equal(earlier, "available", "the earlier revision stopped being available");
  assert.ok(existsSync(first.staging.agentDir), "the earlier revision's directory was removed");

  const status = await wardrobe(h, "bind");
  const binding = status.bindings.find((entry) => entry.preset === canonical);
  // Two, and both are recorded: the first launch of a binding is itself a move
  // from nothing, and dropping it would leave the history starting halfway.
  assert.equal(binding.migrations.length, 2, JSON.stringify(binding.migrations));
  assert.equal(binding.migrations[0].from, null, "the first launch is not recorded as a move");
  assert.match(binding.migrations[0].reason, /first launch/);
  assert.equal(binding.migrations[1].from, first.plan.planId);
  assert.equal(binding.migrations[1].to, second.plan.planId);
  assert.equal(binding.lastLaunched, second.plan.planId);
  assert.match(status.text, /migration:/);
  h.record("follow-migration-recorded", {
    migration: after.migration,
    migrationsInBinding: binding.migrations,
    earlierRevisionStillAvailable: earlier,
  });
});

async function diagnoseThrough(h, planId) {
  const status = await wardrobe(h, `status ${planId}`);
  return status.state;
}

test("strict refuses a missing revision and never substitutes a newer one", async () => {
  const h = harness();
  await installManager(h);
  const presetKey = "strictly";
  const pair = await approvedRevisions(h, { name: "bind-strict", id: presetKey });
  const first = await installSource(h, pair.first);

  const noRevision = await wardrobe(h, `bind ${presetKey} --mode strict`);
  assert.equal(noRevision.ok, false, "strict mode was recorded without a revision");
  assert.match(noRevision.text, /strict mode pins an exact revision/);

  const bound = await wardrobe(h, `bind ${presetKey} --mode strict --revision ${first.plan.planId}`);
  assert.equal(bound.ok, true, JSON.stringify(bound.result?.text));
  assert.equal(bound.binding.mode, "strict");
  assert.equal(bound.binding.revision, first.plan.planId);
  // The binding is stored against the canonical identity, not the short key.
  const canonical = bound.binding.preset;

  // A newer revision is approved; strict stays where it is.
  const second = await installSource(h, pair.second);
  const resolved = await wardrobe(h, `use ${presetKey}`);
  assert.equal(resolved.ok, true, resolved.text);
  assert.equal(resolved.launchPlan.revision, first.plan.planId, "strict moved to a newer revision");

  const status = await wardrobe(h, `status ${first.plan.planId}`);
  const binding = status.bindings.find((entry) => entry.preset === canonical);
  assert.equal(binding.revision, first.plan.planId, "the binding moved off its pin");
  assert.ok(second.plan.planId !== first.plan.planId);

  // And a strict pin whose revision has gone refuses, with the way out named.
  const store = join(h.agentPath("primary"), "wardrobe", "bindings");
  const file = readdirSync(store)
    .filter((entry) => entry.endsWith(".json"))
    .find((entry) =>
      JSON.parse(readFileSync(join(store, entry), "utf8")).preset?.endsWith(`#${presetKey}`)
    );
  assert.ok(file, "the binding was not recorded where the check looks for it");
  const record = JSON.parse(readFileSync(join(store, file), "utf8"));
  record.revision = "0000000000000000";
  writeFileSync(join(store, file), `${JSON.stringify(record, null, 2)}\n`);
  await installSource(h, pair.third);
  const refused = await launchAttempt(h, presetKey);
  assert.notEqual(refused.code, 0, "a strict binding with a missing revision was launched");
  assert.match(refused.stderr, /pinned revision 0000000000000000 is not installed/);
  assert.match(refused.stderr, /switch to follow/);
  assert.doesNotMatch(refused.stderr, /third/);
  h.record("strict-refuses-without-substituting", {
    pinned: first.plan.planId,
    newerApproved: second.plan.planId,
    missingPinnedRefusal: refused.stderr.split("\n").slice(0, 3),
  });
});

/** Run the launcher and capture its outcome, for a refusal path. */
async function launchAttempt(h, target, extraArgs = []) {
  return h.sandbox.runner.run(
    process.execPath,
    [CLI, "--agent-dir", h.agentPath("primary"), "run", target, "--", "--mode", "rpc", "--no-session", ...extraArgs],
    { cwd: h.sandbox.project, env: launchEnv(h), timeoutMs: 90_000 }
  );
}

test("a binding that cannot be satisfied is reported, never as healthy", async () => {
  const h = harness();
  await installManager(h);
  const presetKey = "restricted";
  const git = await repo(h, "bind-restricted", [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify({
          schemaVersion: 1,
          id: presetKey,
          name: "Restricted",
          version: "1.0.0",
          compatibility: { pi: ">=1.1.0 <2.0.0" },
          packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
          resources: [{ package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] }],
          // A requirement the session cannot satisfy: the tool is excluded, so
          // no process can meet it.
          runtime: { thinking: "low", tools: { enable: ["bash"] } },
        })}\n`,
      },
    },
  ]);
  await installSource(h, git.sourceAt(git.commits[0]));

  // A restriction the user placed on this preset.
  const bound = await wardrobe(h, `bind ${presetKey} --mode follow --restrict-tool bash`);
  assert.equal(bound.ok, true, `bind refused: ${JSON.stringify(bound).slice(0, 400)}`);
  assert.deepEqual(bound.binding.restrictions, ["bash"]);
  assert.equal(bound.resolves.revision, null, "a restricted preset resolved to a revision anyway");
  assert.match(bound.resolves.reason, /restricted/);

  // Neither status nor doctor may call that healthy.
  const status = await wardrobe(h, "status");
  assert.equal(status.state, "unmet-binding", `status reports ${status.state}`);
  assert.match(status.text, /bindings resolve to:/);
  assert.match(status.text, /unavailable: .*restricted/);

  const doctor = await wardrobe(h, "doctor");
  assert.equal(doctor.state, "unmet-binding", `doctor reports ${doctor.state}`);
  assert.match(doctor.text, /restriction: bash/);

  // And a launch is refused rather than run without the restriction honoured.
  const refused = await launchAttempt(h, presetKey);
  assert.notEqual(refused.code, 0, "a restricted binding was launched anyway");
  assert.match(refused.stderr, /restricted/);
  h.record("unsatisfiable-binding-not-healthy", {
    state: status.state,
    doctorState: doctor.state,
    reason: bound.resolves.reason,
    launchRefused: refused.code,
  });
});

test("a declared requirement the session cannot meet refuses the launch", async () => {
  const h = harness();
  await installManager(h);
  const presetKey = "unmet";
  const git = await repo(h, "bind-unmet", [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify({
          schemaVersion: 1,
          id: presetKey,
          name: "Unmet",
          version: "1.0.0",
          compatibility: { pi: ">=1.1.0 <2.0.0" },
          runtime: { thinking: "low", tools: { enable: ["read"] } },
        })}\n`,
      },
    },
  ]);
  // The restriction is present while the plan is made, so the installed
  // revision really carries an unmet requirement rather than one added later.
  const source = git.sourceAt(git.commits[0]);
  const reviewed = await wardrobe(h, `install ${source} --disable-tool read`);
  assert.equal(reviewed.ok, true, reviewed.text);
  assert.ok((reviewed.plan.runtime?.tools?.unmet ?? []).length > 0, "the plan recorded no unmet requirement");
  const installed = await wardrobe(h, `install ${source} --disable-tool read --confirm ${reviewed.plan.digest}`);
  assert.equal(installed.ok, true, installed.text);
  assert.equal(installed.state, "available");

  // A binding that would run a revision with an unmet requirement refuses.
  const bound = await wardrobe(h, `bind ${presetKey} --mode follow`);
  assert.equal(bound.state, "bound-unavailable", JSON.stringify(bound.resolves));
  assert.match(bound.resolves.reason, /cannot meet a requirement/);
  assert.ok(bound.restrictions.length > 0, "the unmet requirement was not reported as a restriction");

  // And the launch refuses rather than running without the requirement met.
  const refused = await launchAttempt(h, presetKey);
  assert.notEqual(refused.code, 0, "a revision with an unmet requirement was launched");
  assert.match(refused.stderr, /cannot meet a requirement|restricted/);
  h.record("unmet-requirement-refuses", {
    unmet: reviewed.plan.runtime?.tools?.unmet,
    bindingReason: bound.resolves.reason,
    restrictions: bound.restrictions,
    launchExit: refused.code,
  });
});

test("a conversation persists in one process and resumes in another", async (t) => {
  const h = harness();
  await installManager(h);
  const presetKey = "resuming";
  const pair = await approvedRevisions(h, { name: "bind-resume", id: presetKey });
  const installed = await installSource(h, pair.first);
  await wardrobe(h, `bind ${presetKey} --mode follow`);

  // The revision's own directory, read before the launch: a run record is only
  // written when a process ends, and this check watches the session while it runs.
  const revisionDir = installed.staging.agentDir;

  const first = await launched(h, presetKey, { persist: true });
  t.after(() => first.kill());
  await first.waitForCommands(["fixture-state", "wardrobe"]);
  await first.send("prompt", { message: "/fixture-use-local" });

  const asked = await first.send("prompt", { message: "hello from the first process" });
  assert.equal(asked.success, true, JSON.stringify(asked));
  assert.equal(await waitFor(join(revisionDir, "fixture-request.jsonl")), true, "no request was made");

  // Let the conversation settle, then let Pi persist it.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await first.close();

  const messages = runRecords(h);
  assert.ok(messages.length > 0);
  const firstRun = messages.at(-1);
  assert.equal(firstRun.resumed, false, "a fresh run claimed to have resumed");

  const sessionsDir = join(revisionDir, "wardrobe", "sessions");
  assert.ok(existsSync(sessionsDir), "the run wrote no session directory");
  const stored = findSessionFile(sessionsDir);
  assert.ok(stored, `no persisted session under ${sessionsDir}: ${readdirSync(sessionsDir).join(", ")}`);
  // A session file is JSONL: one record per line.
  const persisted = readFileSync(stored, "utf8");
  assert.ok(
    persisted.includes("hello from the first process"),
    "the conversation was not persisted"
  );
  assert.ok(persisted.includes("fixture reply"), "the assistant's reply was not persisted");

  // A second process resumes it, and finds the same history.
  const resumed = await launched(h, presetKey, { persist: true, launcherArgs: ["--resume", stored] });
  t.after(() => resumed.kill());
  await resumed.waitForCommands(["fixture-state", "wardrobe"]);
  const recovered = await resumed.send("get_messages");
  const text = JSON.stringify(recovered?.data?.messages ?? []);
  assert.ok(
    text.includes("hello from the first process"),
    `the resumed process lost the conversation: ${text.slice(0, 300)}`
  );
  assert.ok(text.includes("fixture reply"), "the resumed process lost the assistant's reply");
  await resumed.send("prompt", { message: "/fixture-use-local" });
  await resumed.send("prompt", { message: "/fixture-state" });
  await resumed.close();

  // The record for the resume, found by the session it continued rather than by
  // recency: the agent directory is shared across this file.
  // Compared by real path: the launcher resolves the session it is given, and
  // on this host that differs from the walked path by a symlinked prefix.
  const realStored = realpathSync(stored);
  const resumedRun = runRecords(h).find(
    (record) => record.resumedSession && realpathSync(record.resumedSession) === realStored
  );
  assert.ok(
    resumedRun,
    `no run record names the session that was resumed: ${JSON.stringify(
      runRecords(h).map((record) => ({ run: record.runId, resumedSession: record.resumedSession ?? null })).slice(-4)
    )}\nstored: ${realStored}`
  );
  assert.equal(resumedRun.resumed, true, "the resumed run did not say so");
  assert.equal(resumedRun.revision, firstRun.revision, "resume changed the revision underneath");

  // The old message and the skill text are unchanged by any of this.
  const after = readFileSync(stored, "utf8");
  assert.ok(
    after.includes("hello from the first process"),
    "resuming rewrote the persisted conversation"
  );
  // Resuming continues the file rather than rewriting it: the history the
  // first process left is an unchanged prefix, with the resumed turn appended.
  assert.ok(after.startsWith(persisted), "resuming rewrote the persisted history");
  assert.ok(after.length > persisted.length, "resuming recorded nothing");
  h.record("conversation-persists-and-resumes", {
    sessionFile: stored.replace(revisionDir, "<revision>"),
    firstProcessExit: firstRun.exitCode,
    resumed: resumedRun.resumed,
    recoveredMessages: (recovered?.data?.messages ?? []).length,
    sameRevision: resumedRun.revision === firstRun.revision,
  });
});

/** The session file Pi wrote under a session directory, newest first. */
function findSessionFile(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) {
        if (statSync(path).size > 0) return path;
      }
    }
  }
  return null;
}
