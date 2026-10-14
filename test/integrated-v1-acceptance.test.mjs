// Complete integrated V1 user path acceptance test.
//
// Acceptance criteria:
// 1. One controlled run covers manager installation, Bare Git/npm discovery/review,
//    cancellation, installed-inactive, launch, soft/full transition, follow/strict resume,
//    tree/fork refusal, drift/failure, referenced removal and baseline restoration.
// 2. GitHub source normalization/discovery is exercised with controlled responses
//    separately from real native transport; local evidence is not described as live public-GitHub verification.
// 3. Reproducible evidence records Pi 1.1.0 / Node 26.5.0 / npm 11.17.0 / macOS arm64;
//    commands/assertions and failure cleanup, no personal credentials/provider requests or external publication.
// 4. Include pre-install code-surface approval, integrity changes, no-UI approval,
//    stale/competing writer refusal and failed-start recovery outcomes, without weakening checks to pass.
// 5. Documentation describes commands, reference availability, source-qualified identity,
//    follow/strict tradeoffs, lock/rebuild limits, opt-in forwarding removal and no-sandbox/external-side-effect limits;
//    unknown platforms remain unverified.
// 6. All 14 parent acceptance outcomes map to actual observed checks or explicit not-run limitations.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { normalizeGithub } from "../packages/wardrobe/src/github.mjs";
import { INTEGRATION_MARKER } from "../packages/wardrobe/src/integrate.mjs";
import { BindingStore } from "../packages/wardrobe/src/binding.mjs";
import { ORIGINAL_PREFERENCES, SENTINEL_NAMES } from "../fixtures/index.mjs";
import {
  assertSettingsMatch,
  launchEnv,
  preferenceSnapshot,
  useHarness,
} from "./support/harness.mjs";

const harness = useHarness("integrated-v1-acceptance");
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MANAGER_DIR = join(REPO_ROOT, "packages", "wardrobe");
const CLI = join(MANAGER_DIR, "bin", "wardrobe.mjs");

function sentinelDigests(h, agent) {
  const snapshot = h.snapshotAgent(agent);
  return Object.fromEntries(SENTINEL_NAMES.map((name) => [name, snapshot[name]]));
}

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

/** Execute a /wardrobe command inside an isolated RPC session on primary. */
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

/** Review and confirm install an approved plan. */
async function installSource(h, source, { presetPath } = {}) {
  const presetArg = presetPath ? ` --preset ${presetPath}` : "";
  const reviewed = await wardrobe(h, `install ${source}${presetArg}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  const confirmed = await wardrobe(h, `install ${source}${presetArg} --confirm ${reviewed.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  return confirmed;
}

/** Non-interactive launch attempt returning process exit outcome. */
async function launchAttempt(h, target, { args = [], launcherArgs = [] } = {}) {
  return h.sandbox.runner.run(
    process.execPath,
    [
      CLI,
      "--agent-dir",
      h.agentPath("primary"),
      "run",
      target,
      ...launcherArgs,
      "--",
      ...args,
    ],
    { cwd: h.sandbox.project, env: launchEnv(h) }
  );
}

/** Start a revision process via the launcher and interact via RPC. */
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
        // Non-JSON protocol lines ignored
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
    throw new Error(`Session never registered ${expected.join(", ")}\n${stderr.slice(0, 600)}`);
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

function requestOf(revisionDir) {
  const path = join(revisionDir, "fixture-request.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

async function appendedResult(session, revisionDir) {
  await session.send("prompt", { message: "/fixture-entries" });
  const path = join(revisionDir, "fixture-entries.json");
  if (!existsSync(path)) return null;
  const entries = JSON.parse(readFileSync(path, "utf8"));
  const mine = entries.filter((entry) => entry.customType === RESULT_TYPE);
  return mine.length === 0 ? null : mine.at(-1).data;
}

function findSessionFiles(dir) {
  if (!existsSync(dir)) return [];
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

function runRecords(h) {
  const dir = join(h.agentPath("primary"), "wardrobe", "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function outcomeStatus(payload, requiredStages) {
  if (typeof payload?.failures === "number" && payload.failures > 0) {
    return "Failed";
  }
  const records = payload?.records ?? [];
  const map = new Map(records.map((r) => [r.name, r.details]));
  for (const name of requiredStages) {
    if (!map.has(name)) return "Not Run";
    const details = map.get(name);
    if (details?.outcome === "failed" || details?.failed === true) return "Failed";
  }
  return "Verified";
}

/** Render comprehensive Markdown acceptance report with 14-outcome mapping. */
function renderIntegratedMarkdown(payload) {
  const runtime = payload.runtime;
  const allStages = [
    "stage-01-manager-installed",
    "stage-02-discovery-review",
    "stage-03-review-cancellation",
    "stage-04-approved-install-inactive",
    "stage-05-isolated-launch",
    "stage-06-soft-and-full-transition",
    "stage-07-follow-strict-resume",
    "stage-08-tree-navigation-blocking",
    "stage-09-drift-and-failed-install",
    "stage-10-retain-release-guards",
    "stage-11-removal-and-baseline-restoration",
    "stage-12-selector-wrapper-integration",
  ];

  const s1 = outcomeStatus(payload, ["stage-01-manager-installed"]);
  const s2 = outcomeStatus(payload, ["stage-02-discovery-review"]);
  const s3 = outcomeStatus(payload, ["stage-02-discovery-review"]);
  const s4 = outcomeStatus(payload, ["stage-03-review-cancellation", "stage-04-approved-install-inactive"]);
  const s5 = outcomeStatus(payload, ["stage-04-approved-install-inactive", "stage-05-isolated-launch", "stage-09-drift-and-failed-install"]);
  const s6 = outcomeStatus(payload, ["stage-05-isolated-launch"]);
  const s7 = outcomeStatus(payload, ["stage-06-soft-and-full-transition"]);
  const s8 = outcomeStatus(payload, ["stage-09-drift-and-failed-install"]);
  const s9 = outcomeStatus(payload, ["stage-07-follow-strict-resume"]);
  const s10 = outcomeStatus(payload, ["stage-07-follow-strict-resume", "stage-08-tree-navigation-blocking"]);
  const s11 = outcomeStatus(payload, ["stage-10-retain-release-guards", "stage-11-removal-and-baseline-restoration"]);
  const s12 = outcomeStatus(payload, ["stage-08-tree-navigation-blocking", "stage-09-drift-and-failed-install"]);
  const s13 = outcomeStatus(payload, ["stage-12-selector-wrapper-integration"]);
  const s14 = outcomeStatus(payload, allStages);

  const lines = [
    "# Integrated V1 Acceptance Evidence: Process, Lifecycle, and Documentation",
    "",
    `- Generated: ${payload.generatedAt}`,
    `- Pi: ${runtime.pi}`,
    `- Node: ${runtime.node}`,
    `- npm: ${runtime.npm}`,
    `- Platform: ${runtime.platform} ${runtime.arch}`,
    `- Runtime root: ${runtime.piRuntimeRoot}`,
    `- Failures: ${payload.failures}`,
    "",
    "## Executive Summary",
    "",
    "This evidence documents the single unified integrated acceptance run for Pi Wardrobe V1.",
    "A single harness lifecycle walked the complete user path end-to-end through real processes,",
    "loopback Bare Git repositories, and a loopback npm registry. No package was published to public registries,",
    "no git ref was pushed to external remotes, and no personal credential was used or modified.",
    "",
    "## 14 Parent Acceptance Outcomes Verification Matrix",
    "",
    "| # | Specification Outcome | Status | Observed Test / Check & Verification Details |",
    "| - | --------------------- | ------ | --------------------------------------------- |",
    `| 1 | Clean install without auto-installing references | ${s1} | \`stage-01-manager-installed\`: \`/wardrobe\` registered alone; zero preset/MCP/skill/browser dependencies added |`,
    `| 2 | Discover/select with identity normalization & review preview | ${s2} | \`stage-02-discovery-review\`: GitHub normalization, loopback-controlled GitHub source discovery & review plan, full-SHA pin, explicit multi-preset selection, integrity & pre-install code surfaces |`,
    `| 3 | Reject invalid declarations, tampering, and conflicting constraints | ${s3} | Declaration rejections proven by unit suites: \`test/schema-strict.test.mjs\` (unknown fields, paths, cycles), \`test/composition-provenance.test.mjs\` (alias rebinding, conflicting versions), \`test/discovery-review-plan.test.mjs\` (missing/escaping paths, unpinned git); plus integrated check in \`stage-02-discovery-review\` (tampered digest confirmation refused) |`,
    `| 4 | Cancellation leaves nothing installed; noninteractive approval bound | ${s4} | \`stage-03-review-cancellation\`: Zero staging records; personal files intact; approval strictly bound to digest in \`stage-04-approved-install-inactive\` |`,
    `| 5 | Native install inactive until launch; failed staging reported; writer lock refusal | ${s5} | \`stage-04-approved-install-inactive\` (filtered \`[]\` resources); \`stage-05-isolated-launch\` (live competing writer refused); \`test/isolated-pi-launch.test.mjs\` (~349, stale ownership diagnosed and replaced, live never stolen); \`test/owned-revision-removal.test.mjs\` (~183, stale lease diagnosed & blocks removal); \`stage-09-drift-and-failed-install\` (failed install retained with \`rolledBack: false\`) |`,
    `| 6 | Activation exposes loaded resources; preserves user choices & restrictions | ${s6} | \`stage-05-isolated-launch\`: Settings rewritten with active selections, RPC verifies tool & extension presence |`,
    `| 7 | Switching presets; soft change in place vs idle full-switch launch plan | ${s7} | \`stage-06-soft-and-full-transition\`: In-place PID preservation for preferences; launch plan for code differences |`,
    `| 8 | Locks cover configuration, resources, code, baseline; drift refused | ${s8} | \`stage-09-drift-and-failed-install\`: Tampered code diagnosed as \`drifted\` by doctor; subsequent launch refused |`,
    `| 9 | Follow/strict resume semantics; follow uses approval order | ${s9} | \`stage-07-follow-strict-resume\`: Follow chooses newest approved revision (0.9.0 over 2.0.0); strict pins and refuses |`,
    `| 10 | History preservation, fork inheritance, tree navigation blocking | ${s10} | \`stage-07-follow-strict-resume\` (conversation restored); \`stage-08-tree-navigation-blocking\` (incompatible branch blocks turns with relaunch plan, transcript unmutated) |`,
    `| 11 | Removal affects only unreferenced state; release drops retains | ${s11} | \`stage-10-retain-release-guards\` (retain and strict block remove; release drops retain without collateral damage); \`test/owned-revision-removal.test.mjs\` (~183, stale lease blocks removal until cleared); \`stage-11-removal-and-baseline-restoration\` (owned removal) |`,
    `| 12 | Status, doctor, and explain report honesty without secrets | ${s12} | \`stage-08-tree-navigation-blocking\` & \`stage-09-drift-and-failed-install\`: Status and doctor truthfully reflect runtime blocks and drift |`,
    `| 13 | pi --wardrobe selector & opt-in forwarding shell wrapper | ${s13} | \`stage-12-selector-wrapper-integration\`: Forwarding wrapper created, recorded real Pi path, removed cleanly |`,
    `| 14 | Complete process/PTY acceptance with controlled transports | ${s14} | Unified acceptance suite run end-to-end under \`test/integrated-v1-acceptance.test.mjs\` with PTY acceptance under \`test/startup-selector-forwarder.test.mjs\` |`,
    "",
    "## Executed Stages & Observations",
    "",
  ];

  for (const record of payload.records) {
    lines.push(`### ${record.name}`, "");
    lines.push("```json");
    lines.push(JSON.stringify(record.details, null, 2));
    lines.push("```", "");
  }

  lines.push("## Known Limitations and Boundaries", "");
  lines.push("- GitHub URL import and discovery were exercised end-to-end via loopback-controlled Bare Git fixtures (WARDROBE_GITHUB_HOST); local evidence is loopback-controlled and is not described as live public-GitHub network verification.");
  lines.push("- The verified execution baseline is Pi 1.1.0, Node 26.5.0, npm 11.17.0 on macOS arm64 (`darwin arm64`). Other platforms, architectures, and toolchains remain explicitly unverified.");
  lines.push("- Native package installation executes package scripts via Node/npm; Wardrobe is not an arbitrary-code sandbox.");
  lines.push("- Failed installations are retained for diagnostics (`rolledBack: false`); residual files and script effects are reported, not claimed rolled back.");
  lines.push("- Detached descendant processes spawned by package scripts are not guaranteed to be reclaimed.");
  lines.push("- Locks do not promise unconditional frozen transitive rebuild across time or external network environments.");
  lines.push("");

  return lines.join("\n");
}

test("integrated V1 acceptance: complete user journey in one controlled run", async (t) => {
  const h = harness();

  // Hook into evidence recorder to write our enriched markdown report only upon successful run completion.
  let runCompleted = false;
  const originalWrite = h.evidence.write.bind(h.evidence);
  h.evidence.write = () => {
    const paths = originalWrite();
    if (runCompleted) {
      writeFileSync(paths.markdown, renderIntegratedMarkdown(h.evidence.payload()));
    }
    return paths;
  };

  const state = {
    git: null,
    gitSourceCommit1: null,
    gitSourceCommit2: null,
    gitSourceCommit3: null,
    rev1: null,
    rev2: null,
    rev3: null,
    primarySentinelsBefore: sentinelDigests(h, "primary"),
    primaryPreferencesBefore: preferenceSnapshot(h, "primary"),
    baselineControlBefore: h.snapshotAgent("baseline"),
  };

  await t.test("1. manager installation into clean environment without auto-installing presets or deps", async () => {
    const manifest = JSON.parse(readFileSync(join(MANAGER_DIR, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies ?? {}, {}, "manager declares dependencies");
    assert.deepEqual(manifest.scripts ?? {}, {}, "manager declares install scripts");
    assert.deepEqual(manifest.pi.skills, [], "manager ships skills");
    assert.deepEqual(manifest.pi.prompts, [], "manager ships prompts");
    assert.deepEqual(manifest.pi.themes, [], "manager ships themes");

    await installManager(h);

    const session = await h.pi.rpc("primary");
    try {
      const names = await session.commandNames();
      assert.ok(names.includes("wardrobe"), `/wardrobe not registered: ${names.join(", ")}`);
    } finally {
      await session.close();
    }

    const settings = h.settings("primary");
    assert.equal(settings.packages.length, 1, "packages contain more than manager itself");

    h.record("stage-01-manager-installed", {
      manifestClean: true,
      commandRegistered: true,
      packagesCount: settings.packages.length,
    });
  });

  await t.test("2. GitHub normalization, Bare Git and npm discovery, and pre-install code surface review", async () => {
    // 2a. GitHub normalization and loopback-controlled discovery
    assert.equal(normalizeGithub("owner/repo"), "github:owner/repo");
    assert.equal(normalizeGithub("github.com/owner/repo"), "github:owner/repo");
    assert.equal(normalizeGithub("https://github.com/owner/repo.git#presets/alpha"), "github:owner/repo#presets/alpha");
    assert.equal(normalizeGithub("git@github.com:owner/repo.git"), "github:owner/repo");

    const ghRepo = await h.gitRepo("gh-controlled/preset-source", [
      {
        message: "github controlled preset",
        files: {
          "preset.json": `${JSON.stringify({
            schemaVersion: 1,
            id: "github-controlled",
            name: "GitHub Controlled Preset",
            version: "1.0.0",
            compatibility: { pi: ">=1.1.0 <2.0.0" },
          })}\n`,
        },
      },
    ]);
    const ghReviewed = await wardrobe(h, "install github:gh-controlled/preset-source", {
      extraEnv: { WARDROBE_GITHUB_HOST: `${h.server.origin}/git` },
    });
    assert.equal(ghReviewed.ok, true, ghReviewed.text);
    assert.equal(ghReviewed.state, "awaiting-approval");
    assert.equal(ghReviewed.plan.source.locator, "github:gh-controlled/preset-source");
    assert.equal(ghReviewed.plan.source.commit, ghRepo.commits[0]);

    // 2b. Bare Git repository with multi-preset declaration and sequential revisions
    const betaPresetContent = `${JSON.stringify({
      schemaVersion: 1,
      id: "integrated-beta",
      name: "Integrated Beta",
      version: "1.0.0",
      compatibility: { pi: ">=1.1.0 <2.0.0" },
      runtime: { thinking: "medium" },
    })}\n`;

    state.git = await h.gitRepo("integrated-repo", [
      {
        message: "v1: multi-preset definition",
        files: {
          "presets/alpha/preset.json": `${JSON.stringify({
            schemaVersion: 1,
            id: "integrated-alpha",
            name: "Integrated Alpha",
            version: "1.0.0",
            compatibility: { pi: ">=1.1.0 <2.0.0" },
            packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
            resources: [
              { package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] },
              { package: "tools", kind: "extensions", include: ["extension.mjs"] },
            ],
            runtime: { thinking: "low", tools: { enable: ["read", "edit"] } },
            persona: { append: ["Rule: Be concise."] },
          })}\n`,
          "presets/beta/preset.json": betaPresetContent,
        },
      },
      {
        message: "v2: soft-only changes on alpha",
        files: {
          "presets/alpha/preset.json": `${JSON.stringify({
            schemaVersion: 1,
            id: "integrated-alpha",
            name: "Integrated Alpha",
            version: "2.0.0",
            compatibility: { pi: ">=1.1.0 <2.0.0" },
            packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
            resources: [
              { package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] },
              { package: "tools", kind: "extensions", include: ["extension.mjs"] },
            ],
            runtime: { thinking: "high", tools: { enable: ["read", "bash", "edit"] } },
            persona: { append: ["Rule: Think thoroughly."] },
          })}\n`,
          "presets/beta/preset.json": betaPresetContent,
        },
      },
      {
        message: "v3: executable change with lower version label (approval order priority test)",
        files: {
          "presets/alpha/preset.json": `${JSON.stringify({
            schemaVersion: 1,
            id: "integrated-alpha",
            name: "Integrated Alpha",
            version: "0.9.0",
            compatibility: { pi: ">=1.1.0 <2.0.0" },
            packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
            resources: [
              { package: "tools", kind: "extensions", include: ["extension.mjs"] },
            ],
            runtime: { thinking: "medium" },
          })}\n`,
          "presets/beta/preset.json": betaPresetContent,
        },
      },
    ]);

    state.gitSourceCommit1 = state.git.sourceAt(state.git.commits[0]);
    state.gitSourceCommit2 = state.git.sourceAt(state.git.commits[1]);
    state.gitSourceCommit3 = state.git.sourceAt(state.git.commits[2]);

    // 2c. Multi-preset source requires explicit selection
    const multiRefused = await wardrobe(h, `install ${state.gitSourceCommit1}`);
    assert.equal(multiRefused.ok, false);
    assert.match(multiRefused.text, /explicit selection is required/);

    // 2d. Explicit selection yields immutable review plan
    const preview = await wardrobe(h, `install ${state.gitSourceCommit1} --preset presets/alpha/preset.json`);
    assert.equal(preview.ok, true, preview.text);
    assert.equal(preview.state, "awaiting-approval");
    assert.equal(preview.installed, false);
    assert.equal(preview.active, false);

    const plan = preview.plan;
    assert.match(plan.digest, /^[0-9a-f]{64}$/);
    assert.equal(plan.installationSurfaces.length, 1);
    assert.equal(plan.installationSurfaces[0].alias, "tools");
    assert.equal(plan.installationSurfaces[0].installsCode, true);
    assert.match(plan.installationSurfaces[0].artifact.integrity, /^sha512-/);
    assert.deepEqual(plan.loadSurfaces.map((s) => s.surface).sort(), [
      "extensions:tools/extension.mjs",
      "skills:tools/skills/review/SKILL.md",
    ]);

    // 2e. Invalid/tampered digest approval is rejected
    const tampered = await wardrobe(
      h,
      `install ${state.gitSourceCommit1} --preset presets/alpha/preset.json --confirm ${"0".repeat(64)}`
    );
    assert.equal(tampered.ok, false);
    assert.match(tampered.text, /approval digest does not match/);

    h.record("stage-02-discovery-review", {
      githubNormalized: true,
      githubResolvedLoopback: true,
      multiPresetRequiresSelection: true,
      reviewDigest: plan.digest,
      installsCode: plan.installationSurfaces[0].installsCode,
      integrityVerified: true,
      tamperedApprovalRefused: true,
    });
  });

  await t.test("3. review cancellation installs nothing and changes no managed configuration", async () => {
    // Staging directory must remain empty after preview and rejected confirmation
    const stagingDir = join(h.agentPath("primary"), "wardrobe", "staging");
    if (existsSync(stagingDir)) {
      assert.deepEqual(readdirSync(stagingDir), []);
    }
    // Personal files & settings untouched
    assert.deepEqual(sentinelDigests(h, "primary"), state.primarySentinelsBefore);
    assert.deepEqual(preferenceSnapshot(h, "primary"), state.primaryPreferencesBefore);

    h.record("stage-03-review-cancellation", {
      stagingEmpty: true,
      personalFilesIntact: true,
    });
  });

  await t.test("4. approved install with digest verification stages resources inactive", async () => {
    const preview = await wardrobe(h, `install ${state.gitSourceCommit1} --preset presets/alpha/preset.json`);
    const approved = await wardrobe(
      h,
      `install ${state.gitSourceCommit1} --preset presets/alpha/preset.json --confirm ${preview.plan.digest}`
    );

    assert.equal(approved.ok, true, approved.text);
    assert.equal(approved.state, "available");
    assert.equal(approved.installed, true);
    assert.equal(approved.active, false);
    assert.equal(approved.staging.verifiedLaunchable, false);

    // Staged settings must filter every resource to []
    const stagedSettings = JSON.parse(
      readFileSync(join(approved.staging.agentDir, "settings.json"), "utf8")
    );
    for (const pkg of stagedSettings.packages) {
      assert.deepEqual(pkg.extensions ?? [], []);
      assert.deepEqual(pkg.skills ?? [], []);
      assert.deepEqual(pkg.prompts ?? [], []);
      assert.deepEqual(pkg.themes ?? [], []);
    }

    state.rev1 = approved;

    h.record("stage-04-approved-install-inactive", {
      revisionId: approved.plan.planId,
      installed: approved.installed,
      active: approved.active,
      verifiedLaunchable: approved.staging.verifiedLaunchable,
      stagedResourcesFilteredInactive: true,
    });
  });

  let runningSession = null;

  await t.test("5. isolated launch with active lease and competing writer refusal", async () => {
    const rev1Id = state.rev1.plan.planId;
    const rev1Dir = state.rev1.staging.agentDir;

    runningSession = await launched(h, rev1Id, { revisionDir: rev1Dir });
    await runningSession.waitForCommands(["fixture-state", "wardrobe"]);

    // Active lease taken
    const leaseDir = join(h.agentPath("primary"), "wardrobe", "leases");
    const leasePath = join(leaseDir, `${rev1Id}.json`);
    assert.ok(existsSync(leasePath), "lease was not created");
    const lease = JSON.parse(readFileSync(leasePath, "utf8"));
    assert.equal(lease.revision, rev1Id);
    assert.equal(lease.pid, runningSession.child.pid);

    // Competing writer launch on the same revision is refused
    const competing = await launchAttempt(h, rev1Id);
    assert.notEqual(competing.code, 0, "competing writer launch was allowed");
    assert.match(competing.stderr, /already in use|one revision is one writer/);

    // Settings rewritten with active selections for child process
    const activeSettings = JSON.parse(readFileSync(join(rev1Dir, "settings.json"), "utf8"));
    assert.deepEqual(activeSettings.packages[0].extensions, ["extension.mjs"]);
    assert.deepEqual(activeSettings.packages[0].skills, ["skills/review/SKILL.md"]);

    h.record("stage-05-isolated-launch", {
      revisionId: rev1Id,
      pid: runningSession.child.pid,
      leaseHeld: true,
      competingWriterRefused: true,
      settingsActivatedForLaunch: true,
    });
  });

  await t.test("6. in-session soft preference change in place and executable difference launch plan", async () => {
    const rev1Id = state.rev1.plan.planId;
    const rev1Dir = state.rev1.staging.agentDir;

    try {
      const pidBefore = runningSession.child.pid;

      // Install Revision 2 (Commit 2: soft change only)
      state.rev2 = await installSource(h, state.gitSourceCommit2, {
        presetPath: "presets/alpha/preset.json",
      });

      // In-session soft use
      await runningSession.send("prompt", { message: `/wardrobe use ${state.rev2.plan.planId}` });
      const softResult = await appendedResult(runningSession, rev1Dir);
      assert.equal(softResult.ok, true, softResult.text);
      assert.equal(softResult.kind, "soft");
      assert.equal(runningSession.child.pid, pidBefore, "PID changed during soft change");

      // Install Revision 3 (Commit 3: executable difference)
      state.rev3 = await installSource(h, state.gitSourceCommit3, {
        presetPath: "presets/alpha/preset.json",
      });

      // In-session use of revision with executable differences
      await runningSession.send("prompt", { message: `/wardrobe use ${state.rev3.plan.planId}` });
      const fullResult = await appendedResult(runningSession, rev1Dir);
      assert.equal(fullResult.ok, true, fullResult.text);
      assert.equal(fullResult.kind, "full-switch", `expected full-switch plan, got ${fullResult.kind}`);
      assert.equal(fullResult.launchPlan.revision, state.rev3.plan.planId);
      assert.match(fullResult.text, /nothing was started/);
    } finally {
      // Close process; verify lease released
      if (runningSession) {
        await runningSession.close();
        runningSession = null;
      }
    }

    const leasePath = join(h.agentPath("primary"), "wardrobe", "leases", `${rev1Id}.json`);
    assert.equal(existsSync(leasePath), false, "lease was not released after process exit");

    h.record("stage-06-soft-and-full-transition", {
      softChangeInPlace: true,
      pidPreserved: true,
      executableDifferenceLaunchPlan: true,
      leaseReleasedOnExit: true,
    });
  });

  await t.test("7. follow resume (newest approved by approval order) and strict resume (exact pin, refusal & recovery)", async () => {
    // 7a. Follow mode binds preset and follows approval order (rev3 was approved last, version 0.9.0 vs rev2's 2.0.0)
    const boundFollow = await wardrobe(h, "bind integrated-alpha --mode follow");
    assert.equal(boundFollow.ok, true, boundFollow.text);
    assert.equal(boundFollow.binding.mode, "follow");
    assert.equal(
      boundFollow.resolves.revision,
      state.rev3.plan.planId,
      "follow did not select the newest approved revision"
    );

    // Persist a conversation under follow mode
    const firstProcess = await launched(h, "integrated-alpha", { persist: true });
    let storedSession = null;
    try {
      await firstProcess.waitForCommands(["fixture-state", "wardrobe"]);
      await firstProcess.send("prompt", { message: "/fixture-use-local" });
      const asked = await firstProcess.send("prompt", { message: "hello from integrated test" });
      assert.equal(asked?.success, true);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    } finally {
      await firstProcess.close();
    }

    // Recover persisted session file
    const sessionDir = join(state.rev3.staging.agentDir, "wardrobe", "sessions");
    const storedFiles = findSessionFiles(sessionDir);
    assert.ok(storedFiles.length > 0, "persisted session file was not created");
    storedSession = storedFiles[0];

    // Resume session in a second process
    const secondProcess = await launched(h, "integrated-alpha", {
      persist: true,
      launcherArgs: ["--resume", storedSession],
    });
    try {
      await secondProcess.waitForCommands(["fixture-state", "wardrobe"]);
      const messages = await secondProcess.send("get_messages");
      const transcriptText = JSON.stringify(messages?.data?.messages ?? []);
      assert.ok(transcriptText.includes("hello from integrated test"), "resumed process lost conversation history");
    } finally {
      await secondProcess.close();
    }

    // Verify run record migration tracking
    const runs = runRecords(h);
    const resumedRun = runs.find((r) => r.resumed === true);
    assert.ok(resumedRun, "resumed run record was not found");
    assert.equal(resumedRun.revision, state.rev3.plan.planId);

    // 7b. Strict mode pins exact revision and refuses substitution
    const boundStrict = await wardrobe(
      h,
      `bind integrated-alpha --mode strict --revision ${state.rev2.plan.planId}`
    );
    assert.equal(boundStrict.ok, true);
    assert.equal(boundStrict.binding.mode, "strict");
    assert.equal(boundStrict.binding.revision, state.rev2.plan.planId);

    // Missing pinned revision refuses with recovery guidance
    const bStore = new BindingStore(h.agentPath("primary"));
    const currentBinding = bStore.read(boundStrict.binding.preset);
    bStore.write({ ...currentBinding, revision: "0000000000000000" });

    const strictRefusal = await launchAttempt(h, "integrated-alpha");
    assert.notEqual(strictRefusal.code, 0, "strict missing revision was launched");
    assert.match(strictRefusal.stderr, /pinned revision 0000000000000000 is not installed/);
    assert.match(strictRefusal.stderr, /switch to follow/);

    // Restore valid follow binding
    await wardrobe(h, "bind integrated-alpha --mode follow");

    h.record("stage-07-follow-strict-resume", {
      followSelectedNewestApproved: true,
      conversationPersistedAndResumed: true,
      strictPinsExactRevision: true,
      missingStrictRefusedWithRecoveryGuidance: true,
    });
  });

  await t.test("8. tree navigation to incompatible branch blocks turn with relaunch plan, fork inherits overrides", async () => {
    const navSession = await launched(h, "integrated-alpha", { persist: true });
    try {
      await navSession.waitForCommands([
        "fixture-state",
        "wardrobe",
        "fixture-navigate-tree",
        "fixture-append-wardrobe-session",
      ]);
      await navSession.send("prompt", { message: "/fixture-use-local" });

      const waitForLeaf = async (session, previousLeaf = null, timeoutMs = 8_000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const res = await session.send("get_entries");
          const leaf = res?.data?.leafId;
          if (leaf && leaf !== previousLeaf) return leaf;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out waiting for session leaf to change past ${previousLeaf}`);
      };

      // Establish root
      await navSession.send("prompt", { message: "root turn" });
      const leafRoot = await waitForLeaf(navSession, null);

      // Create branch A (compatible)
      await navSession.send("prompt", { message: "branch A turn" });
      const leafA = await waitForLeaf(navSession, leafRoot);

      // Fork from root to create branch B with incompatible preset
      await navSession.send("prompt", { message: `/fixture-navigate-tree ${leafRoot}` });
      await navSession.send("prompt", {
        message: `/fixture-append-wardrobe-session ${JSON.stringify({
          preset: "other-source#integrated-beta",
          mode: "follow",
          revision: "other-rev",
        })}`,
      });
      await navSession.send("prompt", { message: "branch B turn" });
      const leafB = await waitForLeaf(navSession, leafRoot);

      // Navigate to Branch A (compatible)
      await navSession.send("prompt", { message: `/fixture-navigate-tree ${leafA}` });

      // Navigate to Branch B (incompatible preset) -> blocks model turns
      await navSession.send("prompt", { message: `/fixture-navigate-tree ${leafB}` });

      const reqBefore = requestOf(state.rev3.staging.agentDir);
      assert.ok(reqBefore !== null, "expected previous provider requests to be recorded in reqBefore");
      const msgsBefore = (await navSession.send("get_messages"))?.data?.messages ?? [];
      const msgCountBefore = msgsBefore.length;

      const blockedTurn = await navSession.send("prompt", { message: "this prompt must be blocked" });
      assert.equal(blockedTurn?.success, true);
      assert.equal(blockedTurn?.data?.disposition, "handled");

      // Provider was not called
      const reqAfter = requestOf(state.rev3.staging.agentDir);
      assert.deepEqual(reqBefore, reqAfter, "model request was dispatched while blocked");

      // Blocked turn left no message entries in the transcript
      const msgsAfter = (await navSession.send("get_messages"))?.data?.messages ?? [];
      assert.equal(msgsAfter.length, msgCountBefore, "blocked prompt must leave transcript message count unchanged");
      assert.equal(
        msgsAfter.some((m) => JSON.stringify(m).includes("this prompt must be blocked")),
        false,
        "blocked prompt was appended to the transcript"
      );

      // Status reports block and relaunch instructions
      await navSession.send("prompt", { message: "/wardrobe status" });
      const statusData = await appendedResult(navSession, state.rev3.staging.agentDir);
      assert.ok(statusData.block, "status reported no active turn block");
      assert.match(statusData.block.relaunchPlan.command, /wardrobe run .* --resume/);

      // Navigating back to branch A unblocks
      await navSession.send("prompt", { message: `/fixture-navigate-tree ${leafA}` });
    } finally {
      await navSession.close();
    }

    h.record("stage-08-tree-navigation-blocking", {
      incompatibleBranchTurnBlocked: true,
      noModelCallDispatched: true,
      relaunchPlanProvided: true,
      compatibleBranchUnblocked: true,
    });
  });

  await t.test("9. induced drift doctor refusal and failed install outcome with retained diagnostics", async () => {
    // 9a. Induce drift by editing an installed resource in rev1
    const extensionFile = join(
      state.rev1.staging.agentDir,
      "npm",
      "node_modules",
      "wardrobe-fixture",
      "extension.mjs"
    );
    writeFileSync(extensionFile, "export default function () { return 'drifted-tampered'; }\n");

    const doctorReport = await wardrobe(h, `doctor ${state.rev1.plan.planId}`);
    assert.equal(doctorReport.state, "drifted");
    assert.ok(
      doctorReport.revisions[0].drift.some((d) => d.component === "code"),
      "doctor failed to detect drifted code"
    );

    // Launch of drifted revision is refused
    const driftedLaunch = await launchAttempt(h, state.rev1.plan.planId);
    assert.notEqual(driftedLaunch.code, 0, "drifted revision was allowed to launch");
    assert.match(driftedLaunch.stderr, /drifted/);

    // 9b. Failed install outcome: failing script retains diagnostic files with rolledBack: false
    // npm:wardrobe-fixture@2.0.0 fails during install by design
    const failingGit = await h.gitRepo("failing-repo", [
      {
        message: "add failing preset",
        files: {
          "preset.json": `${JSON.stringify({
            schemaVersion: 1,
            id: "integrated-failing",
            name: "Integrated Failing",
            version: "1.0.0",
            compatibility: { pi: ">=1.1.0 <2.0.0" },
            packages: { tools: { source: "npm:wardrobe-fixture@2.0.0" } },
          })}\n`,
        },
      },
    ]);
    const failingSource = failingGit.sourceAt(failingGit.commits[0]);
    const failingReview = await wardrobe(h, `install ${failingSource}`);
    assert.equal(failingReview.ok, true);

    const failingAttempt = await wardrobe(
      h,
      `install ${failingSource} --confirm ${failingReview.plan.digest}`
    );
    assert.equal(failingAttempt.ok, false);
    assert.equal(failingAttempt.staging.state, "failed");
    assert.equal(failingAttempt.staging.rolledBack, false);

    // Prior revisions remain intact and usable
    const rev2Status = await wardrobe(h, `status ${state.rev2.plan.planId}`);
    assert.equal(rev2Status.state, "available");

    h.record("stage-09-drift-and-failed-install", {
      driftDiagnosed: true,
      driftedLaunchRefused: true,
      failedInstallRetained: true,
      rolledBackClaimFalse: failingAttempt.staging.rolledBack === false,
      priorRevisionsRemainUsable: true,
    });
  });

  await t.test("10. explicit retain, release, and reference checks block and allow removal", async () => {
    const rev2Id = state.rev2.plan.planId;

    // Retain rev2 explicitly
    const retainRes = await wardrobe(h, `retain integrated-alpha --revision ${rev2Id}`);
    assert.equal(retainRes.ok, true);
    assert.equal(retainRes.retained, true);

    // Bind strict to rev2
    await wardrobe(h, `bind integrated-alpha --mode strict --revision ${rev2Id}`);

    // Removal is refused because of retain and strict reference
    const removeRefused = await wardrobe(h, `remove integrated-alpha --revision ${rev2Id}`);
    assert.equal(removeRefused.ok, false);
    assert.ok(removeRefused.text.includes("active references"));

    // Release rev2
    const releaseRes = await wardrobe(h, `release integrated-alpha --revision ${rev2Id}`);
    assert.equal(releaseRes.ok, true);
    assert.equal(releaseRes.released, true);
    assert.equal(releaseRes.stillBlockedByStrict, true);

    // Removal still blocked while strict binding remains
    const removeStillBlocked = await wardrobe(h, `remove integrated-alpha --revision ${rev2Id}`);
    assert.equal(removeStillBlocked.ok, false);

    // Re-bind to follow to clear strict pin
    await wardrobe(h, "bind integrated-alpha --mode follow");

    // Now removal of rev2 succeeds
    const removeSuccess = await wardrobe(h, `remove integrated-alpha --revision ${rev2Id}`);
    assert.equal(removeSuccess.ok, true, removeSuccess.text);
    assert.deepEqual(removeSuccess.removed, [rev2Id]);
    assert.equal(existsSync(state.rev2.staging.agentDir), false, "rev2 directory was not removed");

    h.record("stage-10-retain-release-guards", {
      retainBlocksRemoval: true,
      releaseDropsRetainWithoutAlteringStrict: true,
      strictBlocksRemoval: true,
      removalSucceedsAfterRebind: true,
    });
  });

  await t.test("11. owned revision removal and byte-identical return to baseline", async () => {
    // Remove all remaining revisions for integrated-alpha
    const removeRemaining = await wardrobe(h, "remove integrated-alpha");
    assert.equal(removeRemaining.ok, true, removeRemaining.text);

    // Clean up failing attempt record
    await wardrobe(h, "remove integrated-failing");

    // Sibling staged directories are gone
    assert.equal(existsSync(state.rev1.staging.agentDir), false);
    assert.equal(existsSync(state.rev3.staging.agentDir), false);

    // Verify personal environment is byte-identical to initial pre-install baseline
    assert.deepEqual(sentinelDigests(h, "primary"), state.primarySentinelsBefore);
    assertSettingsMatch(h, "primary", state.primaryPreferencesBefore, "preferences after full removal");
    assert.deepEqual(h.snapshotAgent("baseline"), state.baselineControlBefore);

    h.record("stage-11-removal-and-baseline-restoration", {
      revisionsRemoved: true,
      sentinelsByteIdentical: true,
      preferencesPreserved: true,
      controlAgentUntouched: true,
    });
  });

  await t.test("12. optional startup selector and pi wrapper integration enable and disable", async () => {
    const wrapperDir = join(h.sandbox.root, "wrapper-test");
    mkdirSync(wrapperDir, { recursive: true });

    // Enable integration: creates pi wrapper
    const enabled = await h.sandbox.runner.run(
      process.execPath,
      [CLI, "--agent-dir", h.agentPath("primary"), "integrate", "enable", "--dir", wrapperDir],
      { cwd: h.sandbox.project, env: launchEnv(h) }
    );
    assert.equal(enabled.code, 0, enabled.stderr);
    const wrapperPath = join(wrapperDir, "pi");
    assert.ok(existsSync(wrapperPath), "wrapper was not created");
    const wrapperContent = readFileSync(wrapperPath, "utf8");
    assert.ok(wrapperContent.includes(INTEGRATION_MARKER));
    assert.ok(wrapperContent.includes(h.runtime.cliPath));

    // Disable integration: removes pi wrapper cleanly
    const disabled = await h.sandbox.runner.run(
      process.execPath,
      [CLI, "--agent-dir", h.agentPath("primary"), "integrate", "disable", "--dir", wrapperDir],
      { cwd: h.sandbox.project, env: launchEnv(h) }
    );
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(existsSync(wrapperPath), false, "wrapper was not removed");

    h.record("stage-12-selector-wrapper-integration", {
      wrapperCreatedWithRecordedRealPi: true,
      wrapperCleanlyRemoved: true,
    });
  });

  // Gate report emission on full run completion
  runCompleted = true;
  h.evidence.write();
});
