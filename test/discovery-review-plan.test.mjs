// Source discovery and the immutable review plan.
//
// Every check drives the manager inside a real isolated Pi session and asserts
// against real retrieval: a Bare Git repository served over loopback, and a
// loopback npm registry. Nothing here installs a package or imports package
// code — that is the property under test.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { normalizeGithub } from "../packages/wardrobe/src/github.mjs";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("discovery-review-plan");
const MANAGER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages/wardrobe");

/** Cached sources, so each repository and package is built once per file. */
const repos = {};
const packages = {};

/** An additional controlled npm package, built once per name. */
async function npmPackage(h, name) {
  packages[name] ??= await h.npmPackage(name, [{ version: "1.0.0", exitCode: 0 }]);
  return packages[name];
}

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

/** Run one /wardrobe invocation and return its recorded result. */
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

function declaration(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "solo",
    name: "Solo",
    version: "1.0.0",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    ...overrides,
  };
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

/** The text a user would actually see for a refusal. */
function refusal(fn) {
  try {
    fn();
  } catch (error) {
    return typeof error.format === "function" ? error.format() : String(error);
  }
  throw new assert.AssertionError({ message: "expected a rejection" });
}

test("GitHub references normalize to one canonical source", () => {
  for (const input of [
    "owner/repo",
    "github.com/owner/repo",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "github:owner/repo",
  ]) {
    assert.equal(normalizeGithub(input), "github:owner/repo", `failed for ${input}`);
  }
  assert.equal(normalizeGithub("github:owner/repo#presets/solo"), "github:owner/repo#presets/solo");
  // A preset path is expressed with `#`, not a tree URL: `/tree/<ref>/...`
  // cannot be split reliably because the ref itself may contain slashes.
  assert.match(refusal(() => normalizeGithub("owner/too/deep")), /owner\/repo/);
  assert.match(refusal(() => normalizeGithub("")), /GitHub source is empty/);
});

test("a Git source is really fetched at a full commit", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "solo", [
    { message: "add solo", files: { "preset.json": `${JSON.stringify(declaration())}\n` } },
  ]);

  const result = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);

  assert.equal(result.ok, true, result.text);
  assert.equal(result.state, "awaiting-approval");
  assert.equal(result.installed, false);
  assert.equal(result.active, false);
  assert.equal(result.plan.source.kind, "git");
  assert.equal(result.plan.source.commit, git.commits[0]);
  assert.match(result.plan.digest, /^[0-9a-f]{64}$/);
  h.record("git-captured-at-full-commit", {
    commit: result.plan.source.commit,
    digest: result.plan.digest,
    installed: result.installed,
  });
});

test("the preview names every install and load surface and exact artifact", async () => {
  const h = harness();
  await installManager(h);
  // Two distinct canonical packages: one canonical package at two versions is
  // a conflict, and a review plan cannot describe both at once (ticket 04).
  const second = await npmPackage(h, "surfaced-second");
  const preset = declaration({
    packages: {
      tools: { source: "npm:wardrobe-fixture@1.0.0" },
      skills: { source: second.sourceAt("1.0.0") },
    },
    resources: [
      { package: "skills", kind: "skills", include: ["skills/review/SKILL.md"] },
      { package: "tools", kind: "extensions", include: ["ext/tool.mjs"], exclude: ["ext/other.mjs"] },
    ],
  });
  const git = await repo(h, "surfaced", [
    { message: "add", files: { "preset.json": `${JSON.stringify(preset)}\n` } },
  ]);

  const result = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);

  assert.equal(result.ok, true, result.text);
  const plan = result.plan;
  assert.deepEqual(
    plan.installationSurfaces.map((surface) => surface.alias).sort(),
    ["skills", "tools"]
  );
  for (const surface of plan.installationSurfaces) {
    assert.ok(surface.artifact.integrity, `${surface.alias} has no integrity`);
    assert.match(surface.artifact.integrity, /^sha512-/);
    assert.ok(surface.artifact.tarball.includes("/npm/"));
  }
  // A package with an install script is a load-bearing surface, so the preview
  // must say so rather than only listing the tarball.
  assert.equal(plan.installationSurfaces.find((s) => s.alias === "tools").installsCode, true);
  assert.equal(plan.installationSurfaces.find((s) => s.alias === "skills").installsCode, true);
  assert.deepEqual(
    plan.resourceSelectors.map((selector) => `${selector.package}:${selector.kind}`).sort(),
    ["skills:skills", "tools:extensions"]
  );
  assert.deepEqual(plan.loadSurfaces.map((surface) => surface.surface).sort(), [
    "extensions:tools/ext/tool.mjs",
    "skills:skills/skills/review/SKILL.md",
  ]);
  assert.ok(
    plan.artifacts.some((artifact) => artifact.includes("wardrobe-fixture-1.0.0.tgz")),
    "npm tarball artifact missing"
  );
  assert.ok(
    plan.artifacts.includes("skills:skills/review/SKILL.md"),
    "resource artifact missing"
  );
  assert.match(result.text, /would install:/);
  assert.match(result.text, /would load:/);
  assert.match(result.text, /digest: [0-9a-f]{64}/);
  h.record("preview-names-surfaces-and-artifacts", {
    installSurfaces: plan.installationSurfaces.length,
    loadSurfaces: plan.loadSurfaces.length,
    artifacts: plan.artifacts.length,
  });
});

test("a self source '.' resolves to the captured package's pinned source", async () => {
  const h = harness();
  await installManager(h);
  const preset = declaration({
    packages: { itself: { source: "." } },
    resources: [{ package: "itself", kind: "skills", include: ["skills/a/SKILL.md"] }],
  });
  const git = await repo(h, "selfsource", [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify(preset)}\n`,
        // A self source ships the resources it selects, so they must exist.
        "skills/a/SKILL.md": "# a\n",
      },
    },
  ]);

  const result = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);
  assert.equal(result.ok, true, result.text);
  const surface = result.plan.installationSurfaces[0];
  assert.equal(surface.source, ".");
  assert.equal(surface.artifact.kind, "git");
  assert.equal(surface.artifact.commit, git.commits[0]);
  assert.ok(
    surface.resolvesTo.endsWith(`@${git.commits[0]}`),
    `self source did not resolve to the pinned source: ${surface.resolvesTo}`
  );
  h.record("self-source-resolves-to-pinned-source", {
    resolvesTo: surface.resolvesTo,
    commit: surface.artifact.commit,
  });
});

test("a multi-preset repository requires explicit selection", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "multi", [
    {
      message: "two presets",
      files: {
        "presets/one/preset.json": `${JSON.stringify(declaration({ id: "one", name: "One" }))}\n`,
        "presets/two/preset.json": `${JSON.stringify(declaration({ id: "two", name: "Two" }))}\n`,
      },
    },
  ]);
  const source = git.sourceAt(git.commits[0]);

  const refused = await wardrobe(h, `install ${source}`);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /explicit selection is required/);
  assert.match(refused.text, /presets\/one\/preset\.json/);
  assert.match(refused.text, /presets\/two\/preset\.json/);

  const selected = await wardrobe(h, `install ${source} --preset presets/two/preset.json`);
  assert.equal(selected.ok, true, selected.text);
  assert.equal(selected.plan.declaration.name, "Two");
  h.record("multi-preset-requires-selection", {
    candidates: ["presets/one/preset.json", "presets/two/preset.json"],
    selected: selected.plan.source.declarationPath,
  });
});

test("equal ids in two repositories stay distinct", async () => {
  const h = harness();
  await installManager(h);
  const preset = declaration({ id: "minimal-coding", name: "Minimal Coding" });
  const alpha = await repo(h, "alpha", [
    { message: "a", files: { "preset.json": `${JSON.stringify({ ...preset, name: "Alpha Minimal" })}\n` } },
  ]);
  const beta = await repo(h, "beta", [
    { message: "b", files: { "preset.json": `${JSON.stringify({ ...preset, name: "Beta Minimal" })}\n` } },
  ]);

  const one = await wardrobe(h, `install ${alpha.sourceAt(alpha.commits[0])}`);
  const two = await wardrobe(h, `install ${beta.sourceAt(beta.commits[0])}`);

  assert.equal(one.plan.identity.id, two.plan.identity.id);
  assert.notEqual(one.plan.identity.source, two.plan.identity.source);
  assert.notEqual(one.plan.digest, two.plan.digest);
  assert.notEqual(one.plan.planId, two.plan.planId);
  h.record("equal-ids-remain-distinct", {
    id: one.plan.identity.id,
    distinctPlanIds: [one.plan.planId, two.plan.planId],
  });
});

test("approval is bound to the displayed digest and invalidated by changes", async () => {
  const h = harness();
  await installManager(h);
  const first = { message: "v1", files: { "preset.json": `${JSON.stringify(declaration())}\n` } };
  const second = {
    message: "v2",
    files: {
      "preset.json": `${JSON.stringify(declaration({ version: "1.1.0", packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } } }))}\n`,
    },
  };
  const git = await repo(h, "digest", [first, second]);

  const shown = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);
  const digest = shown.plan.digest;

  const approved = await wardrobe(
    h,
    `install ${git.sourceAt(git.commits[0])} --confirm ${digest}`
  );
  assert.equal(approved.ok, true, approved.text);
  // Approval is the gate installation now runs behind (ticket 05): the first
  // commit declares no package, so the revision stages with nothing in it.
  assert.equal(approved.state, "available");
  assert.ok(approved.approvedAt, "no approval timestamp recorded");
  assert.equal(approved.installed, true);
  assert.equal(approved.active, false);
  assert.equal(approved.staging.state, "available");
  assert.deepEqual(approved.staging.installed, []);

  const wrong = await wardrobe(h, `install ${git.sourceAt(git.commits[0])} --confirm ${"0".repeat(64)}`);
  assert.equal(wrong.ok, false);
  assert.match(wrong.text, /approval digest does not match/);

  const stale = await wardrobe(h, `install ${git.sourceAt(git.commits[1])} --confirm ${digest}`);
  assert.equal(stale.ok, false, "an approval survived a source change");
  assert.match(stale.text, /source or its artifacts changed/);
  h.record("approval-bound-to-digest", {
    approved: approved.state,
    approvedAt: approved.approvedAt,
    wrongDigestRefused: true,
    changedSourceRefused: true,
  });
});

test("cancelling leaves no managed install or configuration change", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "cancel", [
    { message: "a", files: { "preset.json": `${JSON.stringify(declaration())}\n` } },
  ]);
  const before = h.snapshotAgent("primary");

  const shown = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);
  assert.equal(shown.state, "awaiting-approval");
  assert.equal(shown.installed, false);
  assert.equal(shown.active, false);

  const after = h.snapshotAgent("primary");
  assert.equal(after["auth.json"], before["auth.json"]);
  assert.equal(after["unrelated.txt"], before["unrelated.txt"]);
  const settings = h.settings("primary");
  assert.equal(settings.fixtureUserChoice, "preserve-me");
  assert.equal(settings.theme, "dark");
  // The only declared package is the manager itself: discovery installed nothing.
  assert.equal(settings.packages.length, 1);
  h.record("cancellation-mutates-nothing", {
    unchanged: ["auth.json", "unrelated.txt"],
    packagesDeclared: h.settings("primary").packages.length,
  });
});

test("an npm source is captured with integrity and runs no install script", async () => {
  const h = harness();
  await installManager(h);
  const before = h.markerEvents().length;

  const result = await wardrobe(h, "install npm:wardrobe-fixture@3.0.0");

  assert.equal(result.ok, true, result.text);
  assert.equal(result.plan.source.kind, "npm");
  assert.equal(result.plan.source.version, "3.0.0");
  assert.match(result.plan.source.integrity, /^sha512-/);
  assert.ok(result.plan.source.tarball.includes("/npm/"));
  assert.equal(
    h.markerEvents().length,
    before,
    "npm discovery executed an install script"
  );
  assert.equal(result.installed, false);
  h.record("npm-captured-without-execution", {
    version: result.plan.source.version,
    integrity: result.plan.source.integrity.slice(0, 20),
    lifecycleScriptsRun: 0,
  });
});

test("a git source that is not a full commit is refused before any fetch", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "floating", [
    { message: "a", files: { "preset.json": `${JSON.stringify(declaration())}\n` } },
  ]);

  const result = await wardrobe(h, "install git:https://example.invalid/r.git@main");
  assert.equal(result.ok, false);
  assert.match(result.text, /full commit SHA/);
  h.record("floating-ref-refused", { text: result.text });
});

test("a resource path that escapes or is missing is refused before a plan", async () => {
  const h = harness();
  await installManager(h);
  const cases = [
    {
      name: "escapes",
      build: () =>
        declaration({
          packages: { itself: { source: "." } },
          resources: [{ package: "itself", kind: "skills", include: ["../../../etc/passwd"] }],
        }),
      expect: /package-relative path|resource path refused/,
    },
    {
      name: "missing",
      build: () =>
        declaration({
          packages: { itself: { source: "." } },
          resources: [{ package: "itself", kind: "skills", include: ["skills/absent/SKILL.md"] }],
        }),
      expect: /resource path refused/,
    },
  ];

  for (const testCase of cases) {
    const git = await repo(h, `guarded-${testCase.name}`, [
      {
        message: testCase.name,
        files: {
          "preset.json": `${JSON.stringify(testCase.build())}\n`,
          "skills/present/SKILL.md": "# present\n",
        },
      },
    ]);
    const result = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);
    assert.equal(result.ok, false, `${testCase.name} was accepted`);
    assert.match(result.text, /\/resources\/0\/include/, `${testCase.name}: no path-specific refusal`);
    assert.match(result.text, testCase.expect, `${testCase.name}: ${result.text}`);
    h.record(`self-contained-${testCase.name}-refused`, { text: result.text });
  }
});

test("a symlinked resource path is refused", async () => {
  const h = harness();
  // A symlink cannot be committed to Git, so it can only reach the check by
  // existing in a capture. The guard is the resolver, so it is checked there.
  const { resolvePackagePath } = await import("../packages/wardrobe/src/git-source.mjs");
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const root = resolve(tmpdir(), `wardrobe-symlink-case-${process.pid}`);
  mkdirSync(`${root}/skills`, { recursive: true });
  symlinkSync("/etc/passwd", `${root}/skills/link`);

  let refused = "";
  try {
    resolvePackagePath(root, "skills/link", "/resources/0/include");
  } catch (error) {
    refused = JSON.stringify(error.diagnostics ?? error.message);
  }
  assert.match(refused, /symbolic link/, "a symlinked resource was accepted");
  h.record("symlinked-resource-refused", { diagnostics: refused });
});
