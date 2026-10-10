// Approving a plan and installing it with every resource inactive.
//
// Every check drives the manager inside a real isolated Pi session and installs
// through Pi's own package manager: a loopback npm registry and a Bare Git
// repository served over loopback. The property under test is that a staged
// revision exists on disk, loads nothing, and never claims to be launchable —
// and that a failure stays visible as a failure.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { identityMismatch, installApprovedPlan } from "../packages/wardrobe/src/install.mjs";
import { sealPlan } from "../packages/wardrobe/src/plan.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("staged-inactive-install");
const MANAGER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages/wardrobe");

/** Cached sources, so each repository is built once per file. */
const repos = {};

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

/** Run one /wardrobe invocation and return its result. */
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

/** Review a source, then approve and install the plan it printed. */
async function reviewThenInstall(h, source, { preset } = {}) {
  const selection = preset ? ` --preset ${preset}` : "";
  const reviewed = await wardrobe(h, `install ${source}${selection}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  assert.equal(reviewed.installed, false);
  return { reviewed, confirmed: await wardrobe(h, `install ${source}${selection} --confirm ${reviewed.plan.digest}`) };
}

function declaration(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "staged",
    name: "Staged",
    version: "1.0.0",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    ...overrides,
  };
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

/** A preset selecting one skill from a controlled npm package. */
function npmPreset() {
  return declaration({
    packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
    resources: [{ package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] }],
    runtime: { thinking: "high" },
  });
}

function markerCount(h) {
  return h.markerEvents().filter((event) => event.source === "npm").length;
}

test("an unapproved plan runs no installer and leaves no staging", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "unapproved", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);

  const before = markerCount(h);
  const reviewed = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);

  assert.equal(reviewed.ok, true, reviewed.text);
  assert.equal(reviewed.state, "awaiting-approval");
  assert.equal(reviewed.installed, false);
  assert.equal(reviewed.staging, undefined, "a plan without approval reported staging");
  assert.equal(
    existsSync(join(h.agentPath("primary"), "wardrobe", "staging")),
    false,
    "reviewing created a staging directory"
  );
  assert.equal(markerCount(h), before, "reviewing ran an install script");
  h.record("unapproved-plan-runs-no-installer", {
    state: reviewed.state,
    installScriptsRun: markerCount(h) - before,
    stagingCreated: false,
  });
});

test("an invalidated digest runs no installer", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "invalidated", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);

  const before = markerCount(h);
  const refused = await wardrobe(
    h,
    `install ${git.sourceAt(git.commits[0])} --confirm ${"0".repeat(64)}`
  );

  assert.equal(refused.ok, false);
  assert.match(refused.text, /approval digest does not match the plan/);
  assert.equal(refused.staging, undefined, "a refused approval reported staging");
  assert.equal(
    existsSync(join(h.agentPath("primary"), "wardrobe", "staging")),
    false,
    "a refused approval created staging"
  );
  assert.equal(markerCount(h), before, "a refused approval ran an install script");
  h.record("invalidated-digest-runs-no-installer", {
    refusal: refused.text.split("\n")[0],
    installScriptsRun: markerCount(h) - before,
  });
});

test("an approved plan installs through Pi with every resource filtered inactive", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "staged-npm", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);

  const { confirmed } = await reviewThenInstall(h, git.sourceAt(git.commits[0]));

  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available");
  assert.equal(confirmed.installed, true);
  assert.equal(confirmed.active, false, "installing claimed an active preset");

  const staging = confirmed.staging;
  assert.equal(staging.state, "available");
  assert.equal(staging.resourcesActive, 0);
  assert.equal(staging.verifiedLaunchable, false, "staging claimed launch availability");
  assert.equal(staging.installed.length, 1);
  const [entry] = staging.installed;
  assert.equal(entry.alias, "tools");
  assert.equal(entry.source, "npm:wardrobe-fixture@1.0.0");
  assert.equal(entry.filtered, true, "the installed package is not filtered inactive");
  assert.equal(entry.identity.version, "1.0.0");

  // The staged agent directory really holds the package and really declares it
  // with every resource type filtered out.
  const settings = JSON.parse(readFileSync(join(staging.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(
    settings.packages,
    [
      {
        source: "npm:wardrobe-fixture@1.0.0",
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      },
    ]
  );
  assert.ok(existsSync(join(staging.agentDir, "npm", "node_modules", "wardrobe-fixture")));
  assert.match(confirmed.text, /resources filtered inactive/);
  assert.match(confirmed.text, /resources active: 0/);
  assert.match(confirmed.text, /launch availability is not verified/);
  h.record("approved-plan-installs-inactive", {
    revision: staging.revision,
    attempt: staging.attempt,
    agentDir: staging.agentDir,
    installed: staging.installed,
    resourcesActive: staging.resourcesActive,
    verifiedLaunchable: staging.verifiedLaunchable,
  });
});

test("a staged revision loads nothing in a real Pi process", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "staged-inert", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const { confirmed } = await reviewThenInstall(h, git.sourceAt(git.commits[0]));
  assert.equal(confirmed.ok, true, confirmed.text);

  const loadsBefore = h.extensionEvents().filter((event) => event.event === "load").length;
  const session = await h.pi.rpc("primary", {
    extraEnv: { PI_CODING_AGENT_DIR: confirmed.staging.agentDir },
  });
  try {
    const commands = await session.commandNames();
    assert.ok(
      !commands.includes("fixture-only"),
      `the staged package's extension loaded: ${commands.join(", ")}`
    );
    await session.command("fixture-state");
    const state = session.lastExtensionState();
    assert.ok(
      !(state?.tools ?? []).includes("fixture_probe"),
      `the staged package's tool is active: ${JSON.stringify(state?.tools)}`
    );
    assert.equal(
      h.extensionEvents().filter((event) => event.event === "load").length,
      loadsBefore,
      "starting a process against staging imported the staged extension"
    );
    h.record("staged-revision-loads-nothing", {
      agentDir: confirmed.staging.agentDir,
      fixtureCommandRegistered: false,
      fixtureToolActive: false,
      extensionLoads: 0,
    });
  } finally {
    await session.close();
  }
});

test("a git package is installed at the approved commit", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "staged-git", [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({
            packages: { itself: { source: "." } },
            resources: [{ package: "itself", kind: "skills", include: ["skills/a/SKILL.md"] }],
          })
        )}\n`,
        "skills/a/SKILL.md": "# a\n",
        "package.json": `${JSON.stringify({ name: "staged-self", version: "1.0.0" })}\n`,
      },
    },
  ]);

  const { confirmed } = await reviewThenInstall(h, git.sourceAt(git.commits[0]));

  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.staging.state, "available");
  const [entry] = confirmed.staging.installed;
  assert.equal(entry.source, `git:${h.server.origin}/git/staged-git.git@${git.commits[0]}`);
  assert.equal(entry.filtered, true);
  assert.equal(
    entry.identity.commit,
    git.commits[0],
    "the installed checkout is not the approved commit"
  );
  h.record("git-self-source-installs-at-approved-commit", {
    source: entry.source,
    commit: entry.identity.commit,
    filtered: entry.filtered,
  });
});

test("a self source with no pinned native source refuses to install", async () => {
  // A local snapshot is not a pinned native source, and Pi does not install a
  // local package's dependencies — so the plan's artifacts would silently not
  // be what was approved.
  const sealed = sealPlan({
    planId: "synthetic",
    declaration: { name: "Synthetic", version: "1.0.0", schemaVersion: 1 },
    identity: { source: "local", id: "synthetic" },
    installationSurfaces: [{ alias: "itself", source: ".", resolvesTo: "/tmp/local/snapshot" }],
    resourceSelectors: [],
  });
  const approved = { ...sealed, approved: { digest: sealed.digest, at: "2026-01-01T00:00:00.000Z" } };

  const agentDir = mkdtempSync(join(tmpdir(), "wardrobe-refusal-"));
  await assert.rejects(
    () => installApprovedPlan({ plan: approved, agentDir, env: {} }),
    (error) => {
      assert.match(error.message, /a self source has no pinned native source to install/);
      assert.match(error.format(), /Pi does not install a local package's dependencies/);
      return true;
    }
  );
  assert.equal(
    existsSync(join(agentDir, "wardrobe", "staging")),
    false,
    "a refused install created the staging directory it would have used"
  );

  // A plan whose content changed after approval is refused before anything
  // installs, even though the approval record still names its digest.
  const tampered = { ...approved, declaration: { ...sealed.declaration, name: "Tampered" } };
  await assert.rejects(
    () => installApprovedPlan({ plan: tampered, agentDir, env: {} }),
    (error) => {
      assert.match(error.message, /the approved plan no longer hashes to its digest/);
      return true;
    }
  );
  rmSync(agentDir, { recursive: true, force: true });
});

test("an npm self source installs as its own pinned npm source", async () => {
  const h = harness();
  await installManager(h);
  // The published fixture ships a preset whose only package is itself, so the
  // declared source is "." and the pinned source is the published one.
  const source = h.npm.sourceAt("3.0.0");

  const { confirmed } = await reviewThenInstall(h, source);

  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.staging.state, "available");
  const [entry] = confirmed.staging.installed;
  assert.equal(entry.alias, "itself");
  assert.equal(entry.source, source, "a self source installed something other than its pinned source");
  assert.equal(entry.filtered, true);
  assert.equal(entry.identity.version, "3.0.0");
  const settings = JSON.parse(readFileSync(join(confirmed.staging.agentDir, "settings.json"), "utf8"));
  assert.deepEqual(
    settings.packages,
    [{ source, extensions: [], skills: [], prompts: [], themes: [] }]
  );
  h.record("npm-self-source-installs-its-pinned-source", {
    declaredSource: ".",
    installedSource: entry.source,
    version: entry.identity.version,
    filtered: entry.filtered,
  });
});

test("an artifact that no longer matches the approved plan installs nothing", async () => {
  const h = harness();
  const agentDir = mkdtempSync(join(tmpdir(), "wardrobe-artifact-"));
  const sealed = sealPlan({
    planId: "synthetic-npm",
    declaration: { name: "Synthetic", version: "1.0.0", schemaVersion: 1 },
    identity: { source: "npm:wardrobe-fixture@1.0.0", id: "synthetic" },
    installationSurfaces: [
      {
        alias: "tools",
        source: "npm:wardrobe-fixture@1.0.0",
        resolvesTo: "npm:wardrobe-fixture@1.0.0",
        // A pinned version can be republished, so an approved integrity that the
        // registry no longer serves must stop the install.
        artifact: { kind: "npm", tarball: "https://example.invalid/x.tgz", integrity: "sha512-notwhatserved" },
      },
    ],
    resourceSelectors: [],
  });
  const approved = { ...sealed, approved: { digest: sealed.digest, at: "2026-01-01T00:00:00.000Z" } };

  await assert.rejects(
    () =>
      installApprovedPlan({
        plan: approved,
        agentDir,
        registry: `${h.server.origin}/npm/`,
      }),
    (error) => {
      assert.match(error.message, /the approved artifact no longer matches the registry/);
      assert.match(error.format(), /\/installationSurfaces\/tools\/artifact/);
      assert.match(error.format(), /nothing was installed/);
      return true;
    }
  );
  assert.equal(existsSync(join(agentDir, "wardrobe", "staging")), false, "a refused artifact created staging");

  // A git surface whose artifact disagrees with its own pinned source is the
  // same class of problem, and is caught before anything is fetched.
  const gitSealed = sealPlan({
    planId: "synthetic-git",
    declaration: { name: "Synthetic", version: "1.0.0", schemaVersion: 1 },
    identity: { source: "git:x", id: "synthetic" },
    installationSurfaces: [
      {
        alias: "itself",
        source: `git:${h.server.origin}/git/x.git@${"a".repeat(40)}`,
        resolvesTo: `${h.server.origin}/git/x.git`,
        artifact: { kind: "git", url: `${h.server.origin}/git/x.git`, commit: "b".repeat(40) },
      },
    ],
    resourceSelectors: [],
  });
  await assert.rejects(
    () =>
      installApprovedPlan({
        plan: { ...gitSealed, approved: { digest: gitSealed.digest } },
        agentDir,
      }),
    (error) => {
      assert.match(error.message, /the approved artifact does not match its pinned source/);
      return true;
    }
  );
  rmSync(agentDir, { recursive: true, force: true });
});

test("an identity that cannot be read is a mismatch, not a pass", () => {
  const describe = { missing: "unreadable" };
  assert.equal(
    identityMismatch({ approved: "1.0.0", installed: "1.0.0", ...describe }),
    null,
    "a matching identity was reported as a mismatch"
  );
  assert.equal(
    identityMismatch({ approved: "1.0.0", installed: null, ...describe }),
    "unreadable",
    "an unreadable installed identity passed as a match"
  );
  assert.match(
    identityMismatch({ approved: "1.0.0", installed: "2.0.0", ...describe }),
    /installed 2\.0\.0, approved 1\.0\.0/
  );
  assert.equal(identityMismatch({ approved: null, installed: null, ...describe }), null);
});

test("a failed install is retained as failed, keeps its residual files, and a retry starts clean", async () => {
  const h = harness();
  await installManager(h);
  // 2.0.0's install script writes its marker and then fails.
  const failing = await repo(h, "staged-failing", [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({ packages: { tools: { source: "npm:wardrobe-fixture@2.0.0" } } })
        )}\n`,
      },
    },
  ]);
  const source = failing.sourceAt(failing.commits[0]);

  const { confirmed: failed } = await reviewThenInstall(h, source);
  assert.equal(failed.ok, false, "a failing install script was reported as installed");
  assert.match(failed.text, /staging is retained as failed\/unavailable/);
  assert.match(failed.text, /nothing was rolled back/);

  const failureRecord = failed.staging;
  assert.equal(failureRecord.state, "failed");
  assert.equal(failureRecord.rolledBack, false);
  assert.ok(failureRecord.residual.length > 0, "a failed install reported no residual files");
  assert.ok(existsSync(failureRecord.agentDir), "the failed attempt directory was removed");

  const markers = h.markerEvents().filter((event) => event.version === "2.0.0");
  assert.ok(markers.length > 0, "the failing install script's marker is not evidence");

  // A retry is a new attempt beside the failed one, and the failed files stay.
  const retry = await wardrobe(h, `install ${source} --confirm ${failureRecord.digest}`);
  assert.equal(retry.ok, false, "the retry of a failing install succeeded");
  assert.equal(retry.staging.attempt, 2, "the retry reused the failed attempt directory");
  assert.deepEqual(retry.staging.previousAttemptsRetained, [1]);
  assert.equal(
    existsSync(join(failureRecord.agentDir, "settings.json")),
    true,
    "the failed attempt's files were treated as undone"
  );
  assert.match(retry.text, /earlier attempt\(s\) 1 are retained on disk; this attempt is separate/);
  assert.match(retry.text, /nothing was rolled back/);
  h.record("failed-staging-retained-and-retryable", {
    failedState: failureRecord.state,
    residualFiles: failureRecord.residual.length,
    residualSample: failureRecord.residual.slice(0, 5),
    scriptMarkers: markers.length,
    retryAttempt: retry.staging.attempt,
    previousAttemptsRetained: retry.staging.previousAttemptsRetained,
    rolledBack: retry.staging.rolledBack,
  });
});

test("an available revision is never reinstalled in place", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "staged-stable", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const source = git.sourceAt(git.commits[0]);

  const { confirmed: first } = await reviewThenInstall(h, source);
  assert.equal(first.staging.state, "available");
  const installedAt = readFileSync(
    join(first.staging.agentDir, "npm", "node_modules", "wardrobe-fixture", "package.json"),
    "utf8"
  );

  const markersBefore = markerCount(h);
  const again = await wardrobe(h, `install ${source} --confirm ${first.plan.digest}`);
  assert.equal(again.ok, true, again.text);
  assert.equal(again.staging.state, "available");
  assert.equal(again.staging.alreadyAvailable, true, "an available revision was reinstalled");
  assert.equal(again.staging.agentDir, first.staging.agentDir);
  assert.equal(again.staging.attempt, first.staging.attempt);
  assert.equal(markerCount(h), markersBefore, "an available revision ran its install script again");
  assert.equal(
    readFileSync(join(first.staging.agentDir, "npm", "node_modules", "wardrobe-fixture", "package.json"), "utf8"),
    installedAt
  );

  // A different resolution of the same preset is a different revision, and the
  // available one survives beside it.
  const changed = await repo(h, "staged-stable2", [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({ version: "2.0.0", ...npmPreset(), version: "2.0.0" })
        )}\n`,
      },
    },
  ]);
  const other = await reviewThenInstall(h, changed.sourceAt(changed.commits[0]));
  assert.equal(other.confirmed.ok, true, other.confirmed.text);
  assert.notEqual(other.confirmed.staging.revision, first.staging.revision);
  assert.notEqual(other.confirmed.staging.agentDir, first.staging.agentDir);
  assert.ok(existsSync(first.staging.agentDir), "the earlier revision was disturbed");
  h.record("available-revision-is-not-reinstalled", {
    revision: first.staging.revision,
    secondAttemptRanScripts: markerCount(h) - markersBefore,
    firstRevisionStillPresent: existsSync(first.staging.agentDir),
    distinctRevisions: [
      first.staging.revision,
      other.confirmed.staging.revision,
    ],
  });
});

test("installing never touches the user's own agent directory", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "staged-isolated", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const before = h.snapshotAgent("primary");
  const settingsBefore = h.settingsBytes("primary");

  const { confirmed } = await reviewThenInstall(h, git.sourceAt(git.commits[0]));
  assert.equal(confirmed.ok, true, confirmed.text);

  const after = h.snapshotAgent("primary");
  assert.equal(after["unrelated.txt"], before["unrelated.txt"], "an unrelated file changed");
  assert.equal(after["auth.json"], before["auth.json"], "the credential store changed");
  assert.equal(h.settingsBytes("primary"), settingsBefore, "the user's settings changed");
  assert.ok(
    confirmed.staging.agentDir.startsWith(h.agentPath("primary")),
    "staging is not inside the agent directory this manager owns"
  );
  assert.match(confirmed.staging.agentDir, /wardrobe[/\\]staging/);
  h.record("install-stays-inside-owned-staging", {
    agentDir: confirmed.staging.agentDir,
    unchangedFiles: ["unrelated.txt", "auth.json", "settings.json"],
  });
});
