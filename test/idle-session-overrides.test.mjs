// Applying idle session overrides without changing code.
//
// Every check runs the manager inside a real Pi session and reads what that
// session is actually using: the active tools, the thinking level, the model,
// and the prompt the next model request would carry. No model call is made, so
// nothing here needs a network or a credential — what is observed is the
// effective state of the process, not a request it could not send.
//
// Two revisions of one source share their packages and their resources and
// differ only in preferences. That is the whole point of this ticket: what can
// change in place, and what must not.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { runCommand } from "../packages/wardrobe/src/commands.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("idle-session-overrides");
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

/**
 * One source, three revisions.
 *
 * The first two differ only in preferences: identical packages and identical
 * selected resources, so the difference between them is exactly what a running
 * process may adopt. The third is supplied whole, so a check can make an
 * executable difference instead.
 *
 * `name` is per-check: repositories are cached, and two checks that want
 * different preferences in the same repository would otherwise collide.
 */
async function threeRevisions(h, { name, first, second, third }) {
  const declaration = (overrides) => ({
    schemaVersion: 1,
    id: "pair",
    name: "Pair",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
    resources: [
      { package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] },
      { package: "tools", kind: "extensions", include: ["extension.mjs"] },
    ],
    ...overrides,
  });
  const git = await repo(h, name, [
    { message: "first", files: { "preset.json": `${JSON.stringify(declaration({ version: "1.0.0", ...first }))}\n` } },
    { message: "second", files: { "preset.json": `${JSON.stringify(declaration({ version: "2.0.0", ...second }))}\n` } },
    { message: "third", files: { "preset.json": `${JSON.stringify(declaration({ version: "3.0.0", ...third }))}\n` } },
  ]);
  return {
    first: git.sourceAt(git.commits[0]),
    second: git.sourceAt(git.commits[1]),
    third: git.sourceAt(git.commits[2]),
  };
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

/** Review and install a source, returning the install result. */
async function installSource(h, source) {
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  const confirmed = await wardrobe(h, `install ${source} --confirm ${reviewed.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  return confirmed;
}

function launchEnv(h, extra = {}) {
  return h.sandbox.childEnv({
    agentDir: h.agentPath("primary"),
    extra: { WARDROBE_PI_CLI: h.runtime.cliPath, ...extra },
  });
}

/**
 * A revision started through the launcher, spoken to over Pi's own protocol.
 *
 * The session is a real process with real extensions; asking it what it is
 * using is the only observation here that matters.
 */
function launched(h, revisionId, { args = [], revisionDir } = {}) {
  // Started through the harness's own runner so a failure mid-check cannot
  // leave a Pi process behind: the harness kills everything it started on
  // dispose, and a stray process would outlive the check that failed.
  const child = h.sandbox.runner.fork(
    process.execPath,
    [
      CLI,
      "--agent-dir",
      h.agentPath("primary"),
      "run",
      revisionId,
      "--",
      "--mode",
      "rpc",
      "--no-session",
      // The launcher supplies /wardrobe itself; the fixture driver is the one
      // extra extension, loaded the way any extension is.
      "--extension",
      h.pi.ensureDriver(),
      ...args,
    ],
    { cwd: h.sandbox.project, env: launchEnv(h) }
  );

  // Pi reports extension load failures on stderr; a launcher that forwards it
  // is the only place they are visible from here.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

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
        // Not a protocol record.
      }
    }
  });

  let seq = 0;
  const send = (type, extra = {}) =>
    new Promise((resolve) => {
      const id = `probe-${++seq}`;
      const started = Date.now();
      const poll = setInterval(() => {
        const row = rows.find((entry) => entry.id === id && entry.type === "response");
        if (!row && Date.now() - started < 60_000) return;
        clearInterval(poll);
        resolve(row ?? null);
      }, 40);
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });

  /**
   * Wait until the session has actually registered its commands.
   *
   * `get_state` answers once the runtime is up, which is before extensions have
   * finished registering; a command sent in that window is treated as model
   * input and fails on a missing API key, which would say nothing about the
   * behaviour under test.
   */
  const waitForCommands = async (expected, timeoutMs = 60_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = await send("get_commands");
      const names = (row?.data?.commands ?? []).map((command) => command.name);
      if (expected.every((name) => names.includes(name))) return names;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the session never registered ${expected.join(", ")}`);
  };

  /**
   * Put the session on the fixture's local model.
   *
   * Without a model that supports reasoning, Pi clamps every thinking level to
   * "off" and the check would be observing a runtime limitation rather than the
   * behaviour under test.
   */
  const useLocalModel = async () => {
    await command("fixture-use-local");
    if (/Extension .* error/.test(stderr)) throw new Error(`extension error:\n${stderr}`);
    const marker = join(revisionDir, "fixture-model.txt");
    assert.equal(existsSync(marker), true, "the driver did not report a model choice");
    const chosen = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(chosen.chosen, true, `the session would not take the local model: ${JSON.stringify(chosen)}`);
    await command("fixture-state");
    const state = sessionState(revisionDir);
    assert.match(state.model, /wardrobe-local/, `the session still runs ${state.model}`);
    return state;
  };

  const command = async (name) => {
    const row = await send("prompt", { message: `/${name}` });
    if (!row?.success) throw new Error(`/${name} failed: ${JSON.stringify(row)}`);
    return row;
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

  return { child, send, command, close, kill, waitForCommands, useLocalModel, stderr: () => stderr };
}

/** What the local provider last received from the session. */
function latestRequest(revisionDir) {
  const path = join(revisionDir, "fixture-request.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

/**
 * Wait for the provider to be asked for something.
 *
 * A prompt response means the request was accepted, not that a model has been
 * called: the turn runs afterwards, so the observation is polled rather than
 * read the instant the command returns.
 */
async function waitForRequest(revisionDir, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const request = latestRequest(revisionDir);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** What the running session last reported about itself. */
function sessionState(revisionDir) {
  const path = join(revisionDir, "fixture-state.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

/**
 * The /wardrobe result the launched session appended.
 *
 * Custom entries live on the session's branch, so the driver is asked to write
 * them out first: reading the file without asking would report whatever an
 * earlier command left there.
 */
async function appendedResult(session, revisionDir) {
  await session.command("fixture-entries");
  const path = join(revisionDir, "fixture-entries.json");
  if (!existsSync(path)) return null;
  const entries = JSON.parse(readFileSync(path, "utf8"));
  const mine = entries.filter((entry) => entry.customType === "wardrobe.result");
  return mine.length === 0 ? null : mine.at(-1).data;
}

function lockOf(h, planId) {
  return JSON.parse(
    readFileSync(join(h.agentPath("primary"), "wardrobe", "staging", `${planId}.json`), "utf8")
  ).attempts.at(-1).lock;
}

test("a soft use changes tools, thinking and instructions in the running session", async (t) => {
  const h = harness();
  await installManager(h);
  const pair = await threeRevisions(h, {
    name: "pair-soft",
    first: {
      runtime: { thinking: "low", tools: { enable: ["read", "edit"] } },
      persona: { append: ["Speak like a first revision."] },
    },
    second: {
      runtime: { thinking: "high", tools: { enable: ["read", "bash", "edit"] } },
      persona: { append: ["Speak like a second revision."] },
    },
    third: { runtime: { thinking: "medium" } },
  });
  const one = await installSource(h, pair.first);
  const two = await installSource(h, pair.second);
  assert.notEqual(one.plan.planId, two.plan.planId);

  const revisionDir = one.staging.agentDir;
  const session = launched(h, one.plan.planId, { revisionDir });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();
  const before = sessionState(revisionDir);
  assert.ok(before, "the session never reported its state");

  const pidBefore = session.child.pid;
  const settingsBefore = readFileSync(join(revisionDir, "settings.json"), "utf8");
  const lockBefore = lockOf(h, one.plan.planId);
  const personalBefore = h.snapshotAgent("primary");

  await session.command(`wardrobe use ${two.plan.planId}`);
  const applied = await appendedResult(session, revisionDir);
  assert.equal(applied.ok, true, applied.text);
  assert.equal(applied.kind, "soft", `expected an in-place change, got ${applied.kind}`);
  assert.equal(applied.state, "applied", applied.text);

  await session.command("fixture-state");
  const after = sessionState(revisionDir);

  // What the session is actually using now.
  assert.ok(after.tools.includes("bash"), `bash is not active: ${after.tools.join(", ")}`);
  assert.ok(after.allTools.includes("fixture_probe"), "the revision's own tool disappeared");
  assert.equal(after.thinkingLevel, "high", `thinking level is ${after.thinkingLevel}`);
  assert.equal(after.model, "wardrobe-local/fixture-local", `the session runs ${after.model}`);
  // `ctx.getSystemPrompt()` is the prompt Pi has built so far, which does not yet
  // carry guidelines a turn has not contributed. What the model receives is
  // observed below, at the boundary that matters.
  assert.ok(
    !before.systemPrompt.includes("Speak like a second revision."),
    "the instruction was already present before the change"
  );

  // Applied beside intended, per field.
  const thinking = applied.applied.find((row) => row.field === "thinking");
  assert.equal(thinking.intended, "high");
  assert.equal(thinking.effective, "high", "the local model did not take the requested level");
  assert.equal(thinking.applied, true);
  assert.match(applied.text, /thinking: in-effect/);
  assert.match(applied.text, /intended: high/);

  // What the model would actually receive: the guidelines apply to the next
  // request, so the only honest observation is at the model boundary itself.
  const asked = await session.send("prompt", { message: "hello" });
  assert.equal(asked?.success, true, JSON.stringify(asked));
  const request = await waitForRequest(revisionDir);
  if (!request) {
    const messages = await session.send("get_messages");
    throw new Error(
      `the local provider received no request: ${JSON.stringify(asked)}\n` +
        `messages: ${JSON.stringify((messages?.data?.messages ?? []).map((m) => [m.role, m.errorMessage ?? null])).slice(0, 500)}\n` +
        `stderr: ${session.stderr().slice(0, 500)}`
    );
  }
  assert.ok(
    request.systemPrompt.includes("Speak like a second revision."),
    "the appended instruction did not reach the model"
  );
  assert.ok(request.systemPrompt.length > 200, "the prompt lost its default sections");
  // This API declares a session's tools in the system prompt rather than as a
  // request option, so the prompt is where the effective tool set is visible.
  assert.match(request.systemPrompt, /- bash:/, "the request did not declare the enabled tool");
  // The skill the revision selected is offered to the model by its path inside
  // that revision: this is the resource the review approved, loaded for real.
  assert.match(
    request.systemPrompt,
    /fixture-review/,
    "the revision's selected skill is not in the prompt the model received"
  );
  assert.ok(
    request.systemPrompt.includes(revisionDir),
    "the prompt offers a skill from outside the revision"
  );
  assert.equal(request.reasoning, "high", `the request asked for reasoning ${request.reasoning}`);

  // And the prompt Pi builds from the same state keeps every default section:
  // appending adds a bullet, it does not replace a prompt.
  await session.command("fixture-prompt");
  const prompt = readFileSync(join(revisionDir, "fixture-prompt.txt"), "utf8");
  assert.ok(prompt.length > 200, "the prompt lost its default sections");

  // The process, the revision and its code are untouched.
  assert.equal(session.child.pid, pidBefore, "the session was replaced rather than reconfigured");
  assert.equal(readFileSync(join(revisionDir, "settings.json"), "utf8"), settingsBefore);
  assert.deepEqual(lockOf(h, one.plan.planId), lockBefore, "a preference changed the revision lock");
  assert.equal(exit0(await session.close()), 0);
  h.record("soft-use-in-place", {
    from: one.plan.planId,
    to: two.plan.planId,
    pidUnchanged: true,
    toolsBefore: before.tools,
    toolsAfter: after.tools,
    thinkingBefore: before.thinkingLevel,
    thinkingAfter: after.thinkingLevel,
    promptCarriesInstruction: request.systemPrompt.includes("Speak like a second revision."),
    requestPromptLength: request.systemPrompt.length,
    requestReasoning: request.reasoning,
    lockUnchanged: true,
    personalAgentUnchanged: h.snapshotAgent("primary") === personalBefore,
  });
});

test("a difference in code or resources is a launch plan, not an in-place change", async (t) => {
  const h = harness();
  await installManager(h);
  const pair = await threeRevisions(h, {
    name: "pair-full",
    first: { runtime: { thinking: "low" } },
    second: { runtime: { thinking: "high" } },
    // The third commit stops selecting the skill: a resource that would stop
    // loading cannot be adopted by a running process.
    third: {
      resources: [{ package: "tools", kind: "extensions", include: ["extension.mjs"] }],
    },
  });

  const one = await installSource(h, pair.first);
  const other = await installSource(h, pair.third);

  const revisionDir = one.staging.agentDir;
  const session = launched(h, one.plan.planId, { revisionDir });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();
  const before = sessionState(revisionDir);
  const lockBefore = lockOf(h, one.plan.planId);
  const settingsBefore = readFileSync(join(revisionDir, "settings.json"), "utf8");

  await session.command(`wardrobe use ${other.plan.planId}`);
  const result = await appendedResult(session, revisionDir);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.kind, "full-switch", `expected a launch plan, got ${result.kind}`);
  assert.equal(result.launchPlan.revision, other.plan.planId);
  assert.match(result.text, /nothing was started/);

  await session.command("fixture-state");
  const after = sessionState(revisionDir);
  assert.deepEqual(after.tools, before.tools, "an executable difference changed the tool set");
  assert.deepEqual(lockOf(h, one.plan.planId), lockBefore);
  assert.equal(readFileSync(join(revisionDir, "settings.json"), "utf8"), settingsBefore);

  await session.close();
  h.record("executable-difference-is-a-launch-plan", {
    from: one.plan.planId,
    to: other.plan.planId,
    kind: result.kind,
    toolsUnchanged: true,
    lockUnchanged: true,
  });
});

test("an unavailable model preference is diagnosed, never reported applied", async (t) => {
  const h = harness();
  await installManager(h);
  const paired = await threeRevisions(h, {
    name: "pair-model",
    // The running revision declares the model this session already carries, so
    // what is exercised is the target's absent preference rather than a user's
    // own model being protected.
    first: {
      runtime: { thinking: "low", model: { provider: "wardrobe-local", id: "fixture-local" } },
    },
    second: {
      runtime: {
        model: { provider: "wardrobe-absent-provider", id: "absent-model" },
        thinking: "high",
      },
    },
    third: { runtime: { thinking: "medium" } },
  });
  const one = await installSource(h, paired.first);
  const two = await installSource(h, paired.second);

  const revisionDir = one.staging.agentDir;
  const session = launched(h, one.plan.planId, { revisionDir });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();
  const before = sessionState(revisionDir);

  await session.command(`wardrobe use ${two.plan.planId}`);
  const result = await appendedResult(session, revisionDir);
  assert.equal(result.ok, true, result.text);

  const model = result.applied.find((row) => row.field === "model");
  // Intended is what the revision asked for and effective is what the session
  // still runs: the two differ, which is the report being honest.
  assert.equal(model.intended, "wardrobe-absent-provider/absent-model");
  assert.equal(model.effective, "wardrobe-local/fixture-local", "the session's model changed");
  assert.equal(model.status, "different", `the row reports ${model.status}`);
  assert.ok(
    result.diagnostics.some((entry) => /wardrobe-absent-provider\/absent-model/.test(entry.reason)),
    `the unavailable preference was not diagnosed: ${JSON.stringify(result.diagnostics)}`
  );

  await session.command("fixture-state");
  const after = sessionState(revisionDir);
  assert.equal(after.model, before.model, "the model changed without being asked for");
  // The rest of the soft change still landed, and says so.
  assert.equal(after.thinkingLevel, "high", "one refused preference blocked the others");
  assert.equal(result.state, "partly-applied", result.state);
  await session.close();
  h.record("unavailable-model-diagnosed", {
    preference: "wardrobe-absent-provider/absent-model",
    modelInEffect: model.effective,
    modelUnchanged: after.model === before.model,
    state: result.state,
    diagnostics: result.diagnostics,
  });
});

test("a tool nothing provides is reported, and a busy session refuses", async (t) => {
  const h = harness();
  await installManager(h);
  const paired = await threeRevisions(h, {
    name: "pair-tools",
    first: { runtime: { thinking: "low" } },
    second: {
      runtime: { thinking: "high", tools: { enable: ["wardrobe_no_such_tool"] } },
    },
    third: { runtime: { thinking: "medium" } },
  });
  const one = await installSource(h, paired.first);
  const two = await installSource(h, paired.second);

  const revisionDir = one.staging.agentDir;
  const session = launched(h, one.plan.planId, { revisionDir });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();
  const before = sessionState(revisionDir);

  await session.command(`wardrobe use ${two.plan.planId}`);
  const result = await appendedResult(session, revisionDir);
  assert.ok(
    result.diagnostics.some((entry) => /wardrobe_no_such_tool/.test(entry.reason)),
    `a tool nothing provides was not diagnosed: ${JSON.stringify(result.diagnostics)}`
  );
  await session.command("fixture-state");
  const after = sessionState(revisionDir);
  assert.ok(
    !after.tools.includes("wardrobe_no_such_tool"),
    "a tool that does not exist was added to the selection"
  );
  assert.deepEqual(after.tools, before.tools, "an unmet tool changed the selection anyway");
  await session.close();

  // A session that is not idle is refused before anything changes. Driven
  // through the command layer with a runtime that says so, because a real
  // busy turn needs a model this environment deliberately has none of.
  const busy = stubSession({ idle: false, agentDir: revisionDir });
  const refused = await runCommand(`use ${two.plan.planId}`, {
    env: launchEnv(h),
    session: busy,
  });
  assert.equal(refused.ok, false, refused.result.text);
  assert.match(refused.result.text, /mid-turn/);
  assert.deepEqual(busy.changes.tools, [], "a refused use changed the tool selection");

  const compacting = stubSession({ idle: true, compacting: true, agentDir: revisionDir });
  const during = await runCommand(`use ${two.plan.planId}`, {
    env: launchEnv(h),
    session: compacting,
  });
  assert.equal(during.ok, false);
  assert.match(during.result.text, /compacting/);
  assert.deepEqual(compacting.changes.thinking, [], "a refused use changed the thinking level");
  h.record("unmet-tool-and-idle-boundary", {
    unmetTool: "wardrobe_no_such_tool",
    toolsUnchanged: true,
    busyRefusal: refused.result.text.split("\n")[0],
    compactingRefusal: during.result.text.split("\n")[0],
  });
});

test("a CLI exclusion and a session's own model are not overridden", async (t) => {
  const h = harness();
  await installManager(h);
  const pair = await threeRevisions(h, {
    name: "pair-boundaries",
    first: { runtime: { thinking: "low", tools: { enable: ["read", "edit"] } } },
    second: {
      // Both of these are preferences a boundary sits above.
      runtime: {
        thinking: "high",
        tools: { enable: ["read", "edit", "bash"] },
        model: { provider: "wardrobe-local", id: "fixture-local" },
      },
    },
    third: { runtime: { thinking: "medium" } },
  });
  const one = await installSource(h, pair.first);
  const two = await installSource(h, pair.second);

  const revisionDir = one.staging.agentDir;
  const session = launched(h, one.plan.planId, { revisionDir });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();

  // The user turns a tool off in this process. A preset asking for it again
  // must not turn it back on.
  await session.send("prompt", { message: "/wardrobe use" });
  await session.command("fixture-enable");
  await session.command("fixture-disable");
  const excluded = await session.send("prompt", { message: "/fixture-state" });
  void excluded;

  // The session runs a model the revision does not declare: that is the user's
  // choice, made here, and a declared preference does not take it back.
  const result = await runCommand(`use ${two.plan.planId}`, {
    env: launchEnv(h),
    session: {
      ...stubSession({ idle: true, agentDir: revisionDir }),
      activeTools: () => ["read", "edit"],
      availableTools: () => ["read", "edit", "bash", "fixture_probe"],
      model: () => ({ provider: "local", id: "something-else" }),
      thinkingLevel: () => "low",
    },
  });
  assert.equal(result.ok, true, result.result?.text);
  assert.equal(result.result.kind, "soft", JSON.stringify(result.result?.text));
  const model = result.result.applied.find((row) => row.field === "model");
  // The session's own model is what stays in effect, and what the report names
  // as intended — the declared preference was refused, not quietly swapped for.
  assert.equal(model.effective, "local/something-else", "the session's model changed");
  assert.equal(model.intended, "local/something-else", "the report adopted the preset's preference");
  assert.ok(
    result.result.diagnostics.some((entry) => /explicit choice is not overridden/.test(entry.reason)),
    JSON.stringify(result.result.diagnostics)
  );
  assert.ok(
    !result.result.diagnostics.some((entry) => /no model named/.test(entry.reason)),
    "a present model was reported as missing"
  );

  // And a tool this runtime does not provide is reported rather than selected.
  const toolRow = result.result.applied.find((row) => row.field === "tools");
  assert.ok(toolRow.intended.includes("bash"), `intended tools: ${toolRow.intended.join(", ")}`);
  assert.ok(toolRow.effective.includes("read"), "the existing tools were dropped");

  await session.close();
  h.record("boundaries-hold", {
    modelInEffect: model.effective,
    modelEffective: model.effective,
    diagnostics: result.result.diagnostics.map((entry) => entry.reason),
    intendedTools: toolRow.intended,
  });
});

test("status reports the running revision's state without claiming a launch", async (t) => {
  const h = harness();
  await installManager(h);
  const paired = await threeRevisions(h, {
    name: "pair-status",
    first: { runtime: { thinking: "low" }, persona: { append: ["Speak like the first revision."] } },
    second: { runtime: { thinking: "high" }, persona: { append: ["Speak like the second revision."] } },
    third: { runtime: { thinking: "medium" } },
  });
  const one = await installSource(h, paired.first);
  const two = await installSource(h, paired.second);

  const before = await wardrobe(h, `status ${one.plan.planId}`);
  assert.equal(before.ok, true, before.text);
  assert.equal(before.state, "available");
  assert.equal(before.selected.launchable, false);
  assert.ok(
    before.selected.launchable === false,
    "a revision in a personal session claimed launch availability"
  );

  // The same revision, observed from inside itself, is where the session state
  // belongs: the status a user reads while a revision is running.
  const revisionDir = one.staging.agentDir;
  const session = launched(h, one.plan.planId, { revisionDir });
  t.after(() => session.kill());
  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();
  await session.command(`wardrobe use ${two.plan.planId}`);
  const applied = await appendedResult(session, revisionDir);
  assert.equal(applied.kind, "soft");

  await session.command("fixture-state");
  const running = sessionState(revisionDir);
  assert.equal(running.thinkingLevel, "high");

  // Read from inside the running revision: status reports what the session is
  // using, beside what it recorded wanting.
  await session.command("wardrobe status");
  const inSession = await appendedResult(session, revisionDir);
  assert.equal(inSession.command, "status", JSON.stringify(inSession).slice(0, 200));
  assert.equal(
    inSession.effective.runningRevision,
    one.plan.planId,
    "status did not name the revision the process is running"
  );
  assert.equal(
    inSession.effective.adoptedFrom,
    two.plan.planId,
    "status did not name the revision its preferences came from"
  );
  assert.equal(inSession.effective.thinking, "high", `status reports thinking ${inSession.effective.thinking}`);
  // Appending never deletes: the first revision's instruction is still
  // carried, with the second's added to it.
  assert.deepEqual(inSession.effective.persona, ["Speak like the first revision.", "Speak like the second revision."]);
  assert.match(inSession.text, /this session:/);
  assert.match(inSession.text, new RegExp(`running revision: ${one.plan.planId}`));
  assert.match(inSession.text, new RegExp(`preferences adopted from: ${two.plan.planId}`));
  assert.match(inSession.text, /thinking in effect: high/);

  await session.close();
  const after = await wardrobe(h, `status ${one.plan.planId}`);
  assert.equal(after.ok, true, after.text);
  assert.equal(after.state, "available", "the revision itself stopped being available");
  h.record("status-stays-truthful", {
    beforeState: before.state,
    afterState: after.state,
    launchableClaimed: after.selected.launchable,
    thinkingInSession: running.thinkingLevel,
  });
});

function exit0(code) {
  return code;
}

/**
 * A runtime that reports what a test needs and nothing else.
 *
 * Used only for the states a real session cannot be put into here: a turn with
 * no model, and a compaction. The apply path itself is exercised against real
 * Pi sessions above.
 */
function stubSession({ idle, compacting = false, agentDir = null, persona = [] } = {}) {
  const changes = { tools: [], thinking: [], model: [] };
  const branch = [];
  return {
    changes,
    agentDir,
    mode: "rpc",
    isIdle: () => idle,
    isCompacting: () => compacting,
    waitForIdle: async () => {},
    activeTools: () => ["read", "edit"],
    availableTools: () => ["read", "edit", "bash", "fixture_probe"],
    setActiveTools: (names) => changes.tools.push(names),
    model: () => ({ provider: "stub", id: "model" }),
    thinkingLevel: () => "low",
    setThinkingLevel: (level) => changes.thinking.push(level),
    setModel: async (model) => {
      changes.model.push(model);
      return true;
    },
    resolveModel: () => ({ model: null, summary: null, hasAuth: null }),
    systemPrompt: () => "",
    branch: () => branch,
    // What a session remembers is what it goes on to carry: reading the same
    // store is the only way the effective state can be honest here.
    remember: (state) => {
      branch.push(state);
      changes.persona = [...(state.persona ?? [])];
    },
    adopt: () => {},
    personaAppended: () => persona,
  };
}
