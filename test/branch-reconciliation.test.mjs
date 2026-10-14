// Branch-state navigation and reconciliation in running Pi sessions.
//
// Every check here starts real Pi processes through the launcher and reads what
// they actually did: which revision ran, what a binding resolved to, what tree
// navigation restored, what migrations were recorded, and when model turns were
// blocked. Turns are run against the fixtures' local provider, so nothing here
// needs a credential or a network.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { BindingStore } from "../packages/wardrobe/src/binding.mjs";
import { launchEnv, useHarness } from "./support/harness.mjs";

const harness = useHarness("branch-reconciliation");
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
 * Sources with approved revisions.
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
          resources: [
            { package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] },
            { package: "tools", kind: "extensions", include: ["extension.mjs"] },
          ],
          runtime: { thinking: thinking[0], tools: { enable: ["read", "edit"], disable: ["bash"] } },
          persona: { append: ["First revision guideline."] },
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
          resources: [
            { package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] },
            { package: "tools", kind: "extensions", include: ["extension.mjs"] },
          ],
          runtime: { thinking: thinking[1], tools: { enable: ["read", "edit", "bash"] } },
          persona: { append: ["Second revision guideline."] },
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
          resources: [
            { package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] },
            { package: "tools", kind: "extensions", include: ["extension.mjs"] },
          ],
          runtime: { thinking: thinking[2], tools: { enable: ["read", "edit"] } },
          persona: { append: ["Third revision guideline."] },
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
      ...launcherArgs,
      "--",
      "--mode",
      "rpc",
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
        if (!row && Date.now() - started < 35_000) return;
        clearInterval(poll);
        resolve(row ?? null);
      }, 40);
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });

  const waitForCommands = async (expected, timeoutMs = 35_000) => {
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

  return { child, send, waitForCommands, close, kill, stderr: () => stderr, rows };
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

async function waitForRequest(revisionDir, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const request = requestOf(revisionDir);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function findSessionFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) {
        if (statSync(path).size > 0) files.push(path);
      }
    }
  }
  return files;
}

async function appendedEntries(session, revisionDir) {
  await session.send("prompt", { message: "/fixture-entries" });
  const path = join(revisionDir, "fixture-entries.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

async function appendedResult(session, revisionDir) {
  const entries = await appendedEntries(session, revisionDir);
  const mine = entries.filter((entry) => entry.customType === RESULT_TYPE);
  return mine.length === 0 ? null : mine.at(-1).data;
}

test("fork inherits the selected branch's binding and soft overrides; a persisted fork resumes with those records", async (t) => {
  const h = harness();
  await installManager(h);
  const presetKey = "fork-inherit";
  const pair = await approvedRevisions(h, { name: "fork-inherit-repo", id: presetKey });
  const installed = await installSource(h, pair.first);
  const installedSecond = await installSource(h, pair.second);
  const bound = await wardrobe(h, `bind ${presetKey} --mode follow`);
  assert.equal(bound.ok, true, bound.text);

  const revisionDir = installedSecond.staging.agentDir;

  const first = await launched(h, presetKey, { persist: true });
  t.after(() => first.kill());
  await first.waitForCommands(["fixture-state", "wardrobe"]);
  await first.send("prompt", { message: "/fixture-use-local" });

  // Soft change on the active branch: change thinking/tools via /wardrobe use
  const used = await first.send("prompt", { message: `/wardrobe use ${installed.plan.planId}` });
  assert.equal(used?.success, true, JSON.stringify(used));

  // Send a prompt so Pi persists the conversation and custom entries
  const asked = await first.send("prompt", { message: "message before fork" });
  assert.equal(asked?.success, true, JSON.stringify(asked));
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Trigger clone (fork at current leaf)
  const cloned = await first.send("clone");
  assert.equal(cloned?.success, true, JSON.stringify(cloned));
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await first.close();

  // Inspect the persisted session files
  const sessionsDir = join(revisionDir, "wardrobe", "sessions");
  assert.ok(existsSync(sessionsDir), "sessions directory missing");
  const allSessionFiles = findSessionFiles(sessionsDir);
  assert.ok(allSessionFiles.length >= 2, `expected at least 2 session files, found: ${allSessionFiles.length}`);

  // The forked file must contain wardrobe.session custom entries inheriting the binding and overrides
  const forkedFile = allSessionFiles[allSessionFiles.length - 1];
  const forkedLines = readFileSync(forkedFile, "utf8").trim().split("\n").map(JSON.parse);
  const wardrobeEntries = forkedLines.filter((e) => e.type === "custom" && e.customType === "wardrobe.session");
  assert.ok(wardrobeEntries.length > 0, "the forked session file contains no wardrobe.session records");

  const useRecord = wardrobeEntries.find((e) => e.data.revision === installed.plan.planId);
  assert.ok(useRecord, "wardrobe.session entry from use not found");
  assert.ok(useRecord.data.preset, "wardrobe.session entry lacks preset identity");
  assert.equal(useRecord.data.mode, "follow");
  assert.equal(useRecord.data.thinking, "low");

  const lastRecord = wardrobeEntries.at(-1).data;
  assert.ok(lastRecord.preset, "last wardrobe.session entry lacks preset identity");
  assert.equal(lastRecord.mode, "follow");

  // Resume the fork in a new process
  const resumed = await launched(h, presetKey, {
    persist: true,
    launcherArgs: ["--resume", forkedFile],
  });
  t.after(() => resumed.kill());
  await resumed.waitForCommands(["fixture-state", "wardrobe"]);
  await resumed.send("prompt", { message: "/fixture-use-local" });
  await resumed.send("prompt", { message: "hello in resumed process" });
  const req = await waitForRequest(revisionDir);
  assert.ok(req, "resumed session did not make a model request");
  assert.match(req.systemPrompt, /First revision guideline/, "resumed session did not re-adopt persona");
  assert.equal(req.reasoning, "low", "resumed session did not run with inherited thinking level");

  await resumed.send("prompt", { message: "/fixture-state" });
  const resumedState = stateOf(revisionDir);
  assert.equal(resumedState.thinkingLevel, "low", "resumed session did not retain inherited thinking level");
  assert.ok(resumedState.tools.includes("read"), "resumed session did not retain inherited tools");

  // In resumed session, wardrobe.session records exist and binding identity is preserved
  const resumedEntries = await appendedEntries(resumed, revisionDir);
  const resumedSessionEntry = resumedEntries.find((e) => e.customType === "wardrobe.session");
  assert.ok(resumedSessionEntry, "resumed session lost wardrobe.session entry");
  assert.ok(resumedSessionEntry.data.preset, "resumed session lost preset identity");

  await resumed.close();
});

test("tree navigation restores desired soft fields only if compatible with the active runtime", async (t) => {
  const h = harness();
  await installManager(h);
  const presetKey = "tree-restore";
  const pair = await approvedRevisions(h, {
    name: "tree-restore-repo",
    id: presetKey,
    thinking: ["low", "high", "medium"],
  });
  const rev1 = await installSource(h, pair.first);
  const rev2 = await installSource(h, pair.second);

  // Launch on rev2 directly (the newer approved revision)
  const revisionDir = rev2.staging.agentDir;
  const session = await launched(h, rev2.plan.planId, { persist: true });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe", "fixture-navigate-tree"]);
  await session.send("prompt", { message: "/fixture-use-local" });

  // Send message 1 at root
  await session.send("prompt", { message: "message at fork point" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const forkPointId = (await session.send("get_entries")).data.leafId;

  // Branch 1: adopt rev1 soft settings (thinking: low, tools: read, edit)
  await session.send("prompt", { message: `/wardrobe use ${rev1.plan.planId}` });
  await session.send("prompt", { message: "on branch 1" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const branch1Leaf = (await session.send("get_entries")).data.leafId;

  // Navigate back to forkPointId
  await session.send("prompt", { message: `/fixture-navigate-tree ${forkPointId}` });

  // Branch 2: adopt rev2 soft settings (thinking: high, tools: read, edit, bash)
  await session.send("prompt", { message: `/wardrobe use ${rev2.plan.planId}` });
  await session.send("prompt", { message: "on branch 2" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const branch2Leaf = (await session.send("get_entries")).data.leafId;

  // Currently on Branch 2: verify high thinking and 3 tools
  await session.send("prompt", { message: "/fixture-state" });
  let state = stateOf(revisionDir);
  assert.equal(state.thinkingLevel, "high");
  assert.ok(state.tools.includes("bash"));

  // Navigate tree to Branch 1 leaf: should restore Branch 1 soft settings
  await session.send("prompt", { message: `/fixture-navigate-tree ${branch1Leaf}` });
  await session.send("prompt", { message: "/fixture-state" });
  state = stateOf(revisionDir);
  assert.equal(state.thinkingLevel, "low", "tree navigation did not restore Branch 1 thinking level");
  assert.equal(state.tools.includes("bash"), false, "bash tool was not disabled when restoring Branch 1");

  // Navigate tree back to Branch 2 leaf: should restore Branch 2 soft settings
  await session.send("prompt", { message: `/fixture-navigate-tree ${branch2Leaf}` });
  await session.send("prompt", { message: "/fixture-state" });
  state = stateOf(revisionDir);
  assert.equal(state.thinkingLevel, "high", "tree navigation did not restore Branch 2 thinking level");
  assert.ok(state.tools.includes("bash"), "bash tool was not restored on Branch 2");

  await session.close();
});

test("follow branch navigated mid-process stays on the process's newer approved revision with migration evidence", async (t) => {
  const h = harness();
  await installManager(h);
  const presetKey = "follow-kept";
  const pair = await approvedRevisions(h, {
    name: "follow-kept-repo",
    id: presetKey,
    thinking: ["low", "high", "medium"],
  });
  const rev1 = await installSource(h, pair.first);
  const rev2 = await installSource(h, pair.second);
  const bound = await wardrobe(h, `bind ${presetKey} --mode follow`);
  const canonicalPreset = bound.binding.preset;

  // Process starts running rev2
  const revisionDir = rev2.staging.agentDir;
  const session = await launched(h, presetKey, { persist: true });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe", "fixture-navigate-tree", "fixture-append-wardrobe-session"]);
  await session.send("prompt", { message: "/fixture-use-local" });

  // Send root message
  await session.send("prompt", { message: "root message" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafRoot = (await session.send("get_entries")).data.leafId;

  // Send message on main branch
  await session.send("prompt", { message: "main branch message" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafMain = (await session.send("get_entries")).data.leafId;

  // While rev2 is running, install rev3 into the manager store
  const rev3 = await installSource(h, pair.third);
  assert.equal(rev3.state, "available");

  // Navigate back to root to branch out
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafRoot}` });

  // Create a branch whose desired revision was rev1 (an older revision)
  const appendResult = await session.send("prompt", {
    message: `/fixture-append-wardrobe-session ${JSON.stringify({
      preset: canonicalPreset,
      mode: "follow",
      revision: rev1.plan.planId,
      thinking: "low",
      persona: ["Old rev1 guideline."],
    })}`,
  });
  assert.equal(appendResult?.success, true);
  await session.send("prompt", { message: "turn on older branch" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const oldBranchLeaf = (await session.send("get_entries")).data.leafId;

  // Navigate to main branch (unblocked)
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafMain}` });

  // NOW navigate tree to the older branch
  await session.send("prompt", { message: `/fixture-navigate-tree ${oldBranchLeaf}` });

  // The running process must stay on rev2 (never changing executable resources in-process, and not chasing rev3)
  const bindingStore = new BindingStore(h.agentPath("primary"));
  const bindingRecord = bindingStore.read(canonicalPreset);
  assert.ok(bindingRecord.migrations.length > 0, "follow navigation recorded no migration in durable binding store");

  const lastMig = bindingRecord.migrations.at(-1);
  assert.equal(lastMig.from, rev1.plan.planId);
  assert.equal(lastMig.to, rev2.plan.planId);
  assert.match(lastMig.reason, /follow kept the running newer approved revision/);

  // Status still observes the active revision and code state
  await session.send("prompt", { message: "/wardrobe status" });
  const statusResult = await appendedResult(session, revisionDir);
  assert.equal(statusResult.codeState.revision, rev2.plan.planId);

  await session.close();
});

test("navigation to a branch bound to a different preset blocks the next model turn with relaunch plan", async (t) => {
  const h = harness();
  await installManager(h);

  const presetA = "preset-alpha";
  const presetB = "preset-beta";

  const pairA = await approvedRevisions(h, { name: "repo-alpha", id: presetA });
  const pairB = await approvedRevisions(h, { name: "repo-beta", id: presetB });

  const revA = await installSource(h, pairA.first);
  const revB = await installSource(h, pairB.first);

  const boundA = await wardrobe(h, `bind ${presetA} --mode follow`);
  const boundB = await wardrobe(h, `bind ${presetB} --mode follow`);
  const canonicalA = boundA.binding.preset;
  const canonicalB = boundB.binding.preset;

  // Launch process under Preset A
  const revisionDir = revA.staging.agentDir;
  const session = await launched(h, presetA, { persist: true });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe", "fixture-navigate-tree", "fixture-append-wardrobe-session"]);
  await session.send("prompt", { message: "/fixture-use-local" });

  // Add a user restriction to Preset A's binding to verify observability in session status
  const bStore = new BindingStore(h.agentPath("primary"));
  const bRecord = bStore.read(canonicalA);
  bStore.write({ ...bRecord, restrictions: ["powershell"] });

  // At root: establish root node
  await session.send("prompt", { message: "root message" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafRoot = (await session.send("get_entries")).data.leafId;

  // Branch A: message on branch A
  await session.send("prompt", { message: "message on branch A" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafA = (await session.send("get_entries")).data.leafId;

  // Navigate back to root to branch out
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafRoot}` });

  // Create Branch B with Preset B's binding identity
  await session.send("prompt", {
    message: `/fixture-append-wardrobe-session ${JSON.stringify({
      preset: canonicalB,
      mode: "follow",
      revision: revB.plan.planId,
    })}`,
  });
  await session.send("prompt", { message: "message on branch B" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafB = (await session.send("get_entries")).data.leafId;

  // Navigate to Branch A (compatible)
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafA}` });

  // NOW navigate to Branch B: different preset -> BLOCKED
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafB}` });

  // Clear any existing request record before the blocked turn
  const reqBefore = requestOf(revisionDir);

  // Submit a model prompt while blocked: must be handled without provider request
  const blockedPrompt = await session.send("prompt", { message: "this turn should be blocked" });
  assert.equal(blockedPrompt?.success, true);
  assert.equal(blockedPrompt?.data?.disposition, "handled", "blocked prompt was not handled by input handler");

  // No provider request made
  const reqAfter = requestOf(revisionDir);
  assert.deepEqual(reqBefore, reqAfter, "a model request was sent while blocked");

  // Transcript was not appended with the blocked prompt
  const msgs = (await session.send("get_messages")).data.messages;
  assert.equal(
    msgs.some((m) => JSON.stringify(m).includes("this turn should be blocked")),
    false,
    "blocked prompt was appended to the transcript"
  );

  // /wardrobe status shows active PID, revision, restrictions, and the block with relaunch plan
  await session.send("prompt", { message: "/wardrobe status" });
  const statusResult = await appendedResult(session, revisionDir);
  assert.ok(statusResult.pid, "status did not observe active PID");
  assert.equal(typeof statusResult.pid, "number");
  assert.equal(statusResult.codeState.revision, revA.plan.planId);
  assert.equal(statusResult.codeState.preset, canonicalA);
  assert.ok(statusResult.restrictions.includes("powershell"), "status did not observe restrictions");
  assert.match(statusResult.text, /user restrictions: powershell/, "status text did not observe restrictions");
  assert.ok(statusResult.block, "status did not observe the active block");
  assert.equal(statusResult.block.reason, "preset mismatch");
  assert.match(statusResult.block.relaunchPlan.command, /wardrobe run .* --resume/);
  assert.match(statusResult.text, /turn blocked: preset mismatch/);

  // Navigating back to Branch A unblocks
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafA}` });

  // Status reflects unblocked state
  await session.send("prompt", { message: "/wardrobe status" });
  const unblockedStatus = await appendedResult(session, revisionDir);
  assert.equal(unblockedStatus.block, null, "block was not cleared after navigating to compatible branch");

  // Next prompt succeeds and reaches provider
  const unblockedTurn = await session.send("prompt", { message: "this turn succeeds" });
  assert.equal(unblockedTurn?.success, true);
  const reqSuccess = await waitForRequest(revisionDir);
  assert.ok(reqSuccess, "unblocked turn never reached the model provider");

  await session.close();
});

test("strict revision mismatch on the branch blocks the next model turn with relaunch plan", async (t) => {
  const h = harness();
  await installManager(h);

  const presetKey = "strict-branch";
  const pair = await approvedRevisions(h, { name: "strict-repo", id: presetKey });
  const rev1 = await installSource(h, pair.first);
  const rev2 = await installSource(h, pair.second);

  const bound = await wardrobe(h, `bind ${presetKey} --mode strict --revision ${rev1.plan.planId}`);
  const canonical = bound.binding.preset;

  // Process launched running rev1 in strict mode
  const revisionDir = rev1.staging.agentDir;
  const session = await launched(h, presetKey, { persist: true });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe", "fixture-navigate-tree", "fixture-append-wardrobe-session"]);
  await session.send("prompt", { message: "/fixture-use-local" });

  await session.send("prompt", { message: "root message" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafRoot = (await session.send("get_entries")).data.leafId;

  await session.send("prompt", { message: "message on rev1" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafRev1 = (await session.send("get_entries")).data.leafId;

  // Navigate to root to branch out
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafRoot}` });

  // Create branch pinned to rev2 (strict revision mismatch)
  await session.send("prompt", {
    message: `/fixture-append-wardrobe-session ${JSON.stringify({
      preset: canonical,
      mode: "strict",
      revision: rev2.plan.planId,
    })}`,
  });
  await session.send("prompt", { message: "message on strict rev2 branch" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafStrictRev2 = (await session.send("get_entries")).data.leafId;

  // Navigate to leafRev1 (compatible)
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafRev1}` });

  // NOW navigate to strict mismatch branch
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafStrictRev2}` });

  // Attempt prompt while blocked
  const blocked = await session.send("prompt", { message: "strict prompt should be blocked" });
  assert.equal(blocked?.success, true);
  assert.equal(blocked?.data?.disposition, "handled");

  // Status shows strict mismatch and relaunch plan
  await session.send("prompt", { message: "/wardrobe status" });
  const statusResult = await appendedResult(session, revisionDir);
  assert.ok(statusResult.block);
  assert.equal(statusResult.block.reason, "strict mismatch");
  assert.match(statusResult.block.relaunchPlan.command, new RegExp(`wardrobe run .* --resume`));
  assert.match(statusResult.text, /turn blocked: strict mismatch/);

  // Navigate back unblocks
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafRev1}` });
  await session.send("prompt", { message: "/wardrobe status" });
  const unblockedStatus = await appendedResult(session, revisionDir);
  assert.equal(unblockedStatus.block, null);

  await session.close();
});

test("missing required resource or drift on the branch blocks the next model turn with relaunch plan", async (t) => {
  const h = harness();
  await installManager(h);

  const presetKey = "drift-block";
  const pair = await approvedRevisions(h, { name: "drift-repo", id: presetKey });
  const rev1 = await installSource(h, pair.first);

  const bound = await wardrobe(h, `bind ${presetKey} --mode strict --revision ${rev1.plan.planId}`);
  const canonical = bound.binding.preset;

  const revisionDir = rev1.staging.agentDir;
  const session = await launched(h, presetKey, { persist: true });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe", "fixture-navigate-tree", "fixture-append-wardrobe-session"]);
  await session.send("prompt", { message: "/fixture-use-local" });

  await session.send("prompt", { message: "root message" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leafRoot = (await session.send("get_entries")).data.leafId;

  await session.send("prompt", { message: "message on branch 1" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leaf1 = (await session.send("get_entries")).data.leafId;

  // Navigate to root to create branch 2
  await session.send("prompt", { message: `/fixture-navigate-tree ${leafRoot}` });

  // Tamper with a resource file to cause drift
  const skillFile = join(revisionDir, "npm/node_modules/wardrobe-fixture/skills/review/SKILL.md");
  assert.ok(existsSync(skillFile), "skill file missing");
  writeFileSync(skillFile, "TAMPERED SKILL CONTENT THAT DRIFTS THE LOCK DIGEST");

  // Create branch 2 wanting rev1
  await session.send("prompt", {
    message: `/fixture-append-wardrobe-session ${JSON.stringify({
      preset: canonical,
      mode: "strict",
      revision: rev1.plan.planId,
    })}`,
  });
  await session.send("prompt", { message: "message on branch 2" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const leaf2 = (await session.send("get_entries")).data.leafId;

  // Navigate between branches: navigating to drifted branch 2 blocks
  await session.send("prompt", { message: `/fixture-navigate-tree ${leaf1}` });
  await session.send("prompt", { message: `/fixture-navigate-tree ${leaf2}` });

  // Prompt on drifted branch must be blocked
  const reqBefore = requestOf(revisionDir);
  const blocked = await session.send("prompt", { message: "prompt on drifted branch should be blocked" });
  assert.equal(blocked?.success, true);
  assert.equal(blocked?.data?.disposition, "handled");

  // No provider request made
  const reqAfter = requestOf(revisionDir);
  assert.deepEqual(reqBefore, reqAfter);

  // Status observes the block with relaunch plan
  await session.send("prompt", { message: "/wardrobe status" });
  const statusResult = await appendedResult(session, revisionDir);
  assert.ok(statusResult.block);
  assert.equal(statusResult.block.reason, "drift");
  assert.match(statusResult.block.relaunchPlan.command, /wardrobe run .* --resume/);
  assert.match(statusResult.text, /turn blocked: drift/);

  await session.close();
});
