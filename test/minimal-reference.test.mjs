// Reference preset delivery: Minimal Coding native reference.
//
// Minimal Coding passes through the same review/install/launch pipeline as
// community presets, with zero Perfect Pi, MCP, skill framework or provider
// model dependencies. The declarations match the approved V1 specification,
// and runtime observation verifies native tools, medium reasoning and appended
// persona instructions without touching personal settings.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { PlanStore } from "../packages/wardrobe/src/approval.mjs";
import { installApprovedPlan } from "../packages/wardrobe/src/install.mjs";
import { planFor } from "../packages/wardrobe/src/review.mjs";
import { validateDefinition } from "../packages/wardrobe/src/schema.mjs";
import { discover } from "../packages/wardrobe/src/store.mjs";
import { normalizeToolSelection } from "../packages/wardrobe/src/reconcile.mjs";
import { launchEnv, latestRequest, sessionState, useHarness } from "./support/harness.mjs";

const harness = useHarness("minimal-reference");
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MANAGER_DIR = resolve(REPO_ROOT, "packages", "wardrobe");
const CLI = join(MANAGER_DIR, "bin", "wardrobe.mjs");
const SHIPPED_PRESET_FILE = join(REPO_ROOT, "presets", "minimal-coding", "preset.json");
const SHIPPED_README_FILE = join(REPO_ROOT, "presets", "minimal-coding", "README.md");
const SPEC_FILE = join(REPO_ROOT, "docs", "specs", "wardrobe-v1.md");

/** Extract the approved Minimal Coding JSON example directly from the specification. */
function extractApprovedExample(specPath) {
  const content = readFileSync(specPath, "utf8");
  const heading = "#### Minimal Coding";
  const headingIndex = content.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`Section '${heading}' not found in ${specPath}`);
  }
  const afterHeading = content.slice(headingIndex + heading.length);
  const fenceMatch = afterHeading.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Approved code fence under '${heading}' not found in ${specPath}`);
  }
  const parsed = JSON.parse(fenceMatch[1]);
  if (parsed.id !== "wardrobe/minimal-coding") {
    throw new Error(`Expected preset id 'wardrobe/minimal-coding' in '${heading}' block, got ${parsed.id}`);
  }
  return parsed;
}

/** Cached bare-git repositories so each is built once. */
const repos = {};

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

function presetRoot(h, name) {
  return `${h.sandbox.root}/preset-sources/${name}`;
}

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

/**
 * Launch a revision through the standalone launcher and speak Pi's protocol to it.
 */
function launched(h, revisionId, { revisionDir, args = [] } = {}) {
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
      "--extension",
      h.pi.ensureDriver(),
      ...args,
    ],
    { cwd: h.sandbox.project, env: launchEnv(h) }
  );

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
        // Not an RPC protocol record.
      }
    }
  });

  let seq = 0;
  const send = (type, extra = {}) =>
    new Promise((resolvePromise) => {
      const id = `probe-${++seq}`;
      const started = Date.now();
      const poll = setInterval(() => {
        const row = rows.find((entry) => entry.id === id && entry.type === "response");
        if (!row && Date.now() - started < 30_000) return;
        clearInterval(poll);
        resolvePromise(row ?? null);
      }, 40);
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });

  const waitForCommands = async (expected, timeoutMs = 30_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = await send("get_commands");
      const names = (row?.data?.commands ?? []).map((command) => command.name);
      if (expected.every((name) => names.includes(name))) return names;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`session never registered ${expected.join(", ")}\n${stderr.slice(0, 500)}`);
  };

  const command = async (name) => {
    const row = await send("prompt", { message: `/${name}` });
    if (!row?.success) throw new Error(`/${name} failed: ${JSON.stringify(row)}`);
    return row;
  };

  const useLocalModel = async () => {
    await command("fixture-use-local");
    const marker = join(revisionDir, "fixture-model.txt");
    assert.equal(existsSync(marker), true, "local model marker was not written");
    const chosen = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(chosen.chosen, true, `session did not take the local model: ${JSON.stringify(chosen)}`);
  };

  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    h.sandbox.runner.release(child);
    return code;
  };

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    h.sandbox.runner.release(child);
  };

  return { child, send, command, close, kill, waitForCommands, useLocalModel, stderr: () => stderr };
}

async function waitForRequest(revisionDir, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const request = latestRequest(revisionDir);
    if (request) return request;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test("shipped Minimal Coding declaration matches the approved example exactly", () => {
  assert.equal(existsSync(SHIPPED_PRESET_FILE), true, "presets/minimal-coding/preset.json does not exist");
  assert.equal(existsSync(SHIPPED_README_FILE), true, "presets/minimal-coding/README.md does not exist");
  assert.equal(existsSync(SPEC_FILE), true, "docs/specs/wardrobe-v1.md does not exist");

  const raw = readFileSync(SHIPPED_PRESET_FILE, "utf8");
  const parsed = JSON.parse(raw);

  // Extract the approved example directly from the authoritative specification (docs/specs/wardrobe-v1.md:94-109)
  const approved = extractApprovedExample(SPEC_FILE);
  assert.deepEqual(parsed, approved, "shipped presets/minimal-coding/preset.json drifted from approved example in docs/specs/wardrobe-v1.md");

  // Validate according to strict schema
  const validation = validateDefinition(parsed, { origin: SHIPPED_PRESET_FILE });
  assert.equal(validation.ok, true, `schema validation failed: ${validation.error?.format?.()}`);

  // Author-facing documentation assertions
  const readme = readFileSync(SHIPPED_README_FILE, "utf8");
  assert.match(readme, /# Minimal Coding/);
  assert.match(readme, /read/);
  assert.match(readme, /bash/);
  assert.match(readme, /edit/);
  assert.match(readme, /write/);
  assert.match(readme, /No external packages/);
  assert.match(readme, /No external resources/);
  assert.match(readme, /No Perfect Pi/);
});

test("normalizeToolSelection handles modifiers, removals-only, and restriction matching consistently", () => {
  // Plain tool names are preserved and sorted
  assert.deepEqual(normalizeToolSelection(["read", "bash", "edit", "write"]), ["bash", "edit", "read", "write"]);

  // +modifier entries are normalized to plain names
  assert.deepEqual(normalizeToolSelection(["+bash", "+edit", "+read", "+write"]), ["bash", "edit", "read", "write"]);

  // Mixed additions and removals
  assert.deepEqual(normalizeToolSelection(["+read", "+edit", "-bash"]), ["edit", "read"]);

  // Edge case: removals-only resolves as baseline minus these
  const baseline = ["+read", "+bash", "+edit", "+write"];
  assert.deepEqual(normalizeToolSelection(["-bash"], baseline), ["edit", "read", "write"]);
  assert.deepEqual(normalizeToolSelection(["-edit", "-write"], ["bash", "edit", "read", "write"]), ["bash", "read"]);

  // Empty or invalid input
  assert.deepEqual(normalizeToolSelection([]), []);
  assert.deepEqual(normalizeToolSelection(null), []);

  // Tool object support
  assert.deepEqual(normalizeToolSelection([{ tool: "+bash" }, { tool: "edit" }]), ["bash", "edit"]);
  assert.deepEqual(normalizeToolSelection([{ tool: "-bash" }], ["bash", "read"]), ["read"]);

  // Whitespace trimming and empty name dropping
  assert.deepEqual(normalizeToolSelection(["+"]), []);
  assert.deepEqual(normalizeToolSelection(["-"]), []);
  assert.deepEqual(normalizeToolSelection(["   "]), []);
  assert.deepEqual(normalizeToolSelection(["+   "]), []);
  assert.deepEqual(normalizeToolSelection(["-   "]), []);
  assert.deepEqual(normalizeToolSelection(["+ bash"]), ["bash"]);
  assert.deepEqual(normalizeToolSelection(["  bash  "]), ["bash"]);
  assert.deepEqual(normalizeToolSelection(["- bash"], ["bash", "edit"]), ["edit"]);
});

test("manager functions independently when the reference preset is absent", async () => {
  const h = harness();
  await installManager(h);

  // Discovery without any preset directories finds zero presets
  const emptyDir = presetRoot(h, "empty");
  mkdirSync(emptyDir, { recursive: true });

  const listed = await wardrobe(h, "list", { extraEnv: { WARDROBE_PRESET_DIRS: emptyDir } });
  assert.equal(listed.ok, true);
  assert.equal(listed.presets.length, 0);

  const status = await wardrobe(h, "status");
  assert.equal(status.ok, true);
  assert.equal(status.revisions.length, 0);
  h.record("manager-independent-of-reference-selection", {
    presetsFound: listed.presets.length,
    revisions: status.revisions.length,
  });
});

test("cancelling reference review installs nothing and writes no staging revision", async () => {
  const h = harness();
  await installManager(h);

  const git = await repo(h, "minimal-cancelled", [
    {
      message: "minimal coding reference",
      files: { "preset.json": readFileSync(SHIPPED_PRESET_FILE, "utf8") },
    },
  ]);
  const source = git.sourceAt(git.commits[0]);

  // Review without --confirm
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  assert.equal(reviewed.state, "awaiting-approval");
  assert.equal(reviewed.installed, false);
  assert.match(reviewed.plan.digest, /^[0-9a-f]{64}$/);

  // Assert staging store was not created or holds no records
  const stagingDir = join(h.agentPath("primary"), "wardrobe", "staging");
  assert.equal(existsSync(stagingDir), false, "reviewing created staging directory without approval");

  const status = await wardrobe(h, "status");
  assert.equal(status.ok, true);
  assert.equal(status.revisions.length, 0, "status reported an installed revision after cancellation");

  h.record("reference-cancellation-installs-nothing", {
    state: reviewed.state,
    installed: reviewed.installed,
    digest: reviewed.plan.digest,
  });
});

test("local captured definition reviews, approves, installs, and launches successfully", async (t) => {
  const h = harness();
  await installManager(h);

  const sourceDir = presetRoot(h, "local-minimal");
  const targetDir = join(sourceDir, "minimal-coding");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "preset.json"), readFileSync(SHIPPED_PRESET_FILE, "utf8"));

  // 1. Discovery from local directory
  const { presets, rejected } = discover([sourceDir]);
  assert.equal(rejected.length, 0, "local discovery produced rejections");
  const discovered = presets.find((entry) => entry.id === "wardrobe/minimal-coding");
  assert.ok(discovered, "wardrobe/minimal-coding was not discovered from local root");
  assert.equal(discovered.name, "Minimal Coding");
  assert.equal(discovered.version, "1.0.0");

  // 2. Review produces a sealed plan
  const capture = {
    kind: "local",
    locator: discovered.source,
    root: discovered.source,
    treeDigest: null,
    presets: [discovered],
  };
  const plan = await planFor({
    captured: capture,
    preset: discovered,
    workDir: join(h.agentPath("primary"), "wardrobe", "captures"),
    env: launchEnv(h),
  });
  assert.ok(plan.digest, "review plan has no digest");
  assert.equal(plan.identity.id, "wardrobe/minimal-coding");
  assert.deepEqual(plan.installationSurfaces, []);
  assert.deepEqual(plan.resourceSelectors, []);
  assert.equal(plan.runtime.thinking.value, "medium");
  assert.deepEqual(
    plan.runtime.tools.enabled.map((e) => e.tool).sort(),
    ["bash", "edit", "read", "write"]
  );
  assert.deepEqual(plan.persona.append.map((e) => e.text), [
    "Inspect relevant code before changing it. Keep changes scoped and report checks actually run.",
  ]);

  // Snapshot before install
  const beforeSnapshot = h.snapshotAgent("primary");

  // 3. Approve and install
  const planStore = new PlanStore(h.agentPath("primary"));
  const approved = planStore.save({
    ...plan,
    approved: { digest: plan.digest, at: new Date().toISOString() },
  });
  const installed = await installApprovedPlan({
    plan: approved,
    agentDir: h.agentPath("primary"),
    env: launchEnv(h),
  });
  assert.equal(installed.state, "available");
  assert.equal(installed.record.state, "available");
  assert.equal(installed.record.attempts.length, 1);

  const revisionDir = installed.record.attempts[0].agentDir;
  assert.ok(existsSync(revisionDir), "staged revision agent directory does not exist");

  // 4. Launch revision and observe runtime behaviour
  const session = launched(h, plan.planId, { revisionDir });
  t.after(() => session.kill());

  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();

  await session.command("fixture-state");
  const state = sessionState(revisionDir);
  assert.ok(state, "session never reported fixture-state");
  assert.deepEqual(state.tools.sort(), ["bash", "edit", "read", "write"]);
  assert.equal(state.thinkingLevel, "medium");
  assert.equal(state.model, "wardrobe-local/fixture-local");

  // 5. Send turn and assert request boundary
  const asked = await session.send("prompt", { message: "run code check" });
  assert.equal(asked?.success, true, JSON.stringify(asked));

  const request = await waitForRequest(revisionDir);
  assert.ok(request, "model request was not recorded");
  assert.equal(request.reasoning, "medium", `expected reasoning medium, got ${request.reasoning}`);
  assert.ok(
    request.systemPrompt.includes(
      "Inspect relevant code before changing it. Keep changes scoped and report checks actually run."
    ),
    "system prompt does not include appended instruction"
  );
  assert.match(request.systemPrompt, /- bash:/);
  assert.match(request.systemPrompt, /- edit:/);
  assert.match(request.systemPrompt, /- read:/);
  assert.match(request.systemPrompt, /- write:/);

  await session.close();

  // 6. Assert personal agent directory untouched
  const afterSnapshot = h.snapshotAgent("primary");
  assert.equal(afterSnapshot["auth.json"], beforeSnapshot["auth.json"]);
  assert.equal(afterSnapshot["unrelated.txt"], beforeSnapshot["unrelated.txt"]);
  assert.equal(afterSnapshot["settings.json"], beforeSnapshot["settings.json"]);

  h.record("local-captured-definition-pipeline-verified", {
    planId: plan.planId,
    digest: plan.digest,
    revisionDir,
    tools: state.tools,
    thinking: state.thinkingLevel,
    reasoning: request.reasoning,
    personalStatePreserved: true,
  });
});

test("local captured definition mutation after review/approval invalidates digest and refuses install", async () => {
  const h = harness();
  await installManager(h);

  const sourceDir = presetRoot(h, "local-mutation-check");
  const targetDir = join(sourceDir, "minimal-coding");
  mkdirSync(targetDir, { recursive: true });
  const presetPath = join(targetDir, "preset.json");
  writeFileSync(presetPath, readFileSync(SHIPPED_PRESET_FILE, "utf8"));

  // 1. Initial review and plan
  const { presets } = discover([sourceDir]);
  const discovered = presets.find((entry) => entry.id === "wardrobe/minimal-coding");
  assert.ok(discovered);

  const capture = {
    kind: "local",
    locator: discovered.source,
    root: discovered.source,
    treeDigest: null,
    presets: [discovered],
  };
  const plan = await planFor({
    captured: capture,
    preset: discovered,
    workDir: join(h.agentPath("primary"), "wardrobe", "captures"),
    env: launchEnv(h),
  });

  const planStore = new PlanStore(h.agentPath("primary"));
  const approved = planStore.save({
    ...plan,
    approved: { digest: plan.digest, at: new Date().toISOString() },
  });

  // 2. Mutate local preset declaration on disk after review/approval
  const mutated = JSON.parse(readFileSync(presetPath, "utf8"));
  mutated.runtime.thinking = "high";
  writeFileSync(presetPath, JSON.stringify(mutated, null, 2));

  // 3. Re-discovering and planning yields a different digest
  const rediscovery = discover([sourceDir]);
  const redisoveredPreset = rediscovery.presets.find((entry) => entry.id === "wardrobe/minimal-coding");
  assert.notEqual(redisoveredPreset.digest, discovered.digest, "declaration digest was unchanged after local file edit");

  const newPlan = await planFor({
    captured: { ...capture, presets: [redisoveredPreset] },
    preset: redisoveredPreset,
    workDir: join(h.agentPath("primary"), "wardrobe", "captures"),
    env: launchEnv(h),
  });
  assert.notEqual(newPlan.digest, plan.digest, "plan digest was unchanged after local declaration mutation");

  // 4. Attempting to install with tampered plan or outdated digest is refused
  const tamperedPlan = {
    ...approved,
    runtime: { ...approved.runtime, thinking: { ...approved.runtime.thinking, value: "high" } },
  };
  await assert.rejects(
    () => installApprovedPlan({
      plan: tamperedPlan,
      agentDir: h.agentPath("primary"),
      env: launchEnv(h),
    }),
    (error) => {
      assert.match(error.message, /approved plan no longer hashes to its digest/);
      return true;
    }
  );
});

test("pinned Git fixture import reviews, installs, and launches with effective runtime observations", async (t) => {
  const h = harness();
  await installManager(h);

  const git = await repo(h, "minimal-coding-git-import", [
    {
      message: "minimal coding reference",
      files: { "preset.json": readFileSync(SHIPPED_PRESET_FILE, "utf8") },
    },
  ]);
  const source = git.sourceAt(git.commits[0]);
  assert.match(source, /^git:.*@[0-9a-f]{40}$/, "Git source is not pinned to a full commit SHA");

  const beforeSnapshot = h.snapshotAgent("primary");

  // 1. Review via /wardrobe install
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  assert.equal(reviewed.state, "awaiting-approval");
  assert.equal(reviewed.installed, false);
  assert.equal(reviewed.plan.source.kind, "git");
  assert.equal(reviewed.plan.source.commit, git.commits[0]);
  assert.equal(reviewed.plan.identity.id, "wardrobe/minimal-coding");
  assert.deepEqual(reviewed.plan.installationSurfaces, []);
  assert.deepEqual(reviewed.plan.resourceSelectors, []);
  assert.equal(reviewed.plan.runtime.thinking.value, "medium");
  assert.deepEqual(
    reviewed.plan.runtime.tools.enabled.map((e) => e.tool).sort(),
    ["bash", "edit", "read", "write"]
  );
  assert.deepEqual(reviewed.plan.persona.append.map((e) => e.text), [
    "Inspect relevant code before changing it. Keep changes scoped and report checks actually run.",
  ]);

  // 2. Approve and install
  const confirmed = await wardrobe(h, `install ${source} --confirm ${reviewed.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  assert.equal(confirmed.staging.state, "available");

  const revisionDir = confirmed.staging.agentDir;
  assert.ok(existsSync(revisionDir), "staged revision agent directory does not exist");

  // 3. Launch through standalone launcher
  const session = launched(h, confirmed.plan.planId, { revisionDir });
  t.after(() => session.kill());

  await session.waitForCommands(["fixture-state", "wardrobe"]);
  await session.useLocalModel();

  await session.command("fixture-state");
  const state = sessionState(revisionDir);
  assert.ok(state, "session never reported fixture-state");
  assert.deepEqual(state.tools.sort(), ["bash", "edit", "read", "write"]);
  assert.equal(state.thinkingLevel, "medium");
  assert.equal(state.model, "wardrobe-local/fixture-local");

  // 4. Send turn and assert request boundary
  const asked = await session.send("prompt", { message: "verify git reference import" });
  assert.equal(asked?.success, true, JSON.stringify(asked));

  const request = await waitForRequest(revisionDir);
  assert.ok(request, "model request was not recorded");
  assert.equal(request.reasoning, "medium", `expected reasoning medium, got ${request.reasoning}`);
  assert.ok(
    request.systemPrompt.includes(
      "Inspect relevant code before changing it. Keep changes scoped and report checks actually run."
    ),
    "system prompt does not include appended instruction"
  );
  assert.match(request.systemPrompt, /- bash:/);
  assert.match(request.systemPrompt, /- edit:/);
  assert.match(request.systemPrompt, /- read:/);
  assert.match(request.systemPrompt, /- write:/);

  await session.close();

  // 5. Assert personal agent directory untouched
  const afterSnapshot = h.snapshotAgent("primary");
  assert.equal(afterSnapshot["auth.json"], beforeSnapshot["auth.json"]);
  assert.equal(afterSnapshot["unrelated.txt"], beforeSnapshot["unrelated.txt"]);
  assert.equal(afterSnapshot["settings.json"], beforeSnapshot["settings.json"]);

  h.record("git-pinned-reference-import-verified", {
    commit: git.commits[0],
    source,
    planId: confirmed.plan.planId,
    digest: confirmed.plan.digest,
    revisionDir,
    tools: state.tools,
    thinking: state.thinkingLevel,
    reasoning: request.reasoning,
    personalStatePreserved: true,
  });
});
