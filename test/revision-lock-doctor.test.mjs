// Verifying installed revisions and diagnosing drift.
//
// Every check here runs the manager inside a real isolated Pi session against
// the loopback npm registry and Git fixtures. Nothing is inspected in the
// abstract: a revision is installed through Pi, then the lock is re-measured
// from the files that are actually on disk, and the reported state has to
// match what a real change did to them.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { diagnoseRevision } from "../packages/wardrobe/src/doctor.mjs";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { satisfies } from "../packages/wardrobe/src/semver.mjs";
import { useHarness } from "./support/harness.mjs";
import { writePreset } from "./support/presets.mjs";

const harness = useHarness("revision-lock-doctor");
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

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

/** A preset that selects a skill the controlled npm package really ships. */
function npmPreset(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "locked",
    name: "Locked",
    version: "1.0.0",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
    resources: [{ package: "tools", kind: "skills", include: ["skills/review/SKILL.md"] }],
    ...overrides,
  };
}

async function gitPreset(h, name, overrides = {}, extraCommits = []) {
  const git = await repo(h, name, [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify(
          {
            schemaVersion: 1,
            id: "locked-git",
            name: "Locked Git",
            version: "1.0.0",
            compatibility: { pi: ">=1.1.0 <2.0.0" },
            resources: [{ package: "itself", kind: "skills", include: ["skills/a/SKILL.md"] }],
            packages: { itself: { source: "." } },
            ...overrides,
          }
        )}\n`,
        "skills/a/SKILL.md": "---\nname: a\ndescription: a\n---\n\n# a\n",
        "package.json": `${JSON.stringify({ name: `locked-${name}`, version: "1.0.0" })}\n`,
      },
    },
    ...extraCommits,
  ]);
  return { git, source: git.sourceAt(git.commits[0]) };
}

/** Review, approve and install a preset source; returns the install result. */
async function installSource(h, source, label) {
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  assert.equal(reviewed.installed, false);
  const confirmed = await wardrobe(h, `install ${source} --confirm ${reviewed.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  return { confirmed, planId: confirmed.plan.planId, label };
}

/** The stored record and plan for one installed revision. */
function stored(h, planId) {
  const agent = h.agentPath("primary");
  return {
    agent,
    record: JSON.parse(readFileSync(join(agent, "wardrobe", "staging", `${planId}.json`), "utf8")),
    planPath: join(agent, "wardrobe", "plans", `${planId}.json`),
    plan: JSON.parse(readFileSync(join(agent, "wardrobe", "plans", `${planId}.json`), "utf8")),
  };
}

/**
 * Diagnose from this process, naming the Pi build the way a Pi session would.
 *
 * A real session resolves its own Pi executable from `process.argv[1]`. These
 * checks run outside one, so the CLI is named explicitly — otherwise the
 * baseline comparison would report an unknown Pi rather than a comparison.
 */
function measuringEnv(h) {
  return { ...process.env, WARDROBE_PI_CLI: h.runtime.cliPath };
}

async function diagnose(h, planId) {
  const { record, plan } = stored(h, planId);
  return diagnoseRevision(record, { env: measuringEnv(h), plan });
}

test("an installed revision publishes a complete lock", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "lock-basic", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const { confirmed, planId } = await installSource(h, git.sourceAt(git.commits[0]), "basic");
  const { record } = stored(h, planId);
  const lock = record.attempts.at(-1).lock;

  // The four independent measurements the availability claim depends on.
  assert.equal(lock.schemaVersion, 1);
  assert.match(lock.configuration.digest, /^[0-9a-f]{64}$/);
  assert.equal(lock.configuration.content.identity.id, "locked");
  assert.deepEqual(
    lock.configuration.content.sources.map((entry) => entry.source),
    ["npm:wardrobe-fixture@1.0.0"]
  );
  assert.equal(lock.resources.length, 1);
  assert.equal(lock.resources[0].path, "skills/review/SKILL.md");
  assert.match(lock.resources[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(lock.code.roots, ["npm"]);
  assert.ok(lock.code.files > 0, "the code fingerprint covers no files");
  assert.ok(lock.code.digest);
  assert.ok(lock.baseline.pi, "the lock records no Pi version");
  assert.ok(lock.baseline.node, "the lock records no Node version");
  assert.ok(lock.baseline.npm, "the lock records no npm version");
  assert.ok(lock.baseline.platform);
  assert.deepEqual(
    lock.runtimeData.map((root) => root.path),
    ["sessions", "wardrobe"],
    "runtime data is not declared"
  );

  // The lock is measured, and measuring it again moves nothing.
  const report = await diagnose(h, planId);
  assert.equal(report.state, "available", JSON.stringify(report.drift));
  assert.equal(report.recorded, "available");
  assert.deepEqual(report.drift, []);
  assert.deepEqual(report.unverified, []);
  assert.equal(report.launchable, false, "a verified lock claims launch availability");

  // The install result reports the lock, and still claims no launch.
  assert.equal(confirmed.staging.lockDigest, report.lock.digest);
  assert.equal(confirmed.staging.verifiedLaunchable, false);
  assert.match(confirmed.text, /lock: [0-9a-f]{16}/);
  h.record("installed-revision-publishes-lock", {
    revision: planId,
    configuration: lock.configuration.digest,
    resources: lock.resources,
    code: { roots: lock.code.roots, files: lock.code.files, packages: lock.code.packages },
    baseline: lock.baseline,
    runtimeData: lock.runtimeData.map((root) => root.path),
  });
});

test("git internals and credentials are excluded; installed code is not", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "lock-exclusions", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const { planId } = await installSource(h, git.sourceAt(git.commits[0]), "exclusions");
  const { record } = stored(h, planId);
  const packageDir = join(record.attempts.at(-1).agentDir, "npm", "node_modules", "wardrobe-fixture");

  // Git's own metadata and a credential are not installed code, and neither
  // may move the fingerprint or leak into a report.
  const secret = "sk-fixture-must-not-appear-anywhere";
  writeFileSync(join(packageDir, "auth.json"), `${JSON.stringify({ token: secret })}\n`);
  writeFileSync(join(packageDir, ".npmrc"), `//registry.example/:_authToken=${secret}\n`);
  const gitDir = join(packageDir, ".git", "refs");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), `${secret}\n`);

  const excluded = await diagnose(h, planId);
  assert.equal(excluded.state, "available", JSON.stringify(excluded.drift));
  assert.equal(excluded.lock.digest, excluded.observed.lockDigest);
  assert.ok(
    excluded.observed.code.excludedCount >= 3,
    `exclusions were not counted: ${JSON.stringify(excluded.observed.code.excluded)}`
  );
  assert.ok(
    excluded.observed.code.excluded.some(
      (entry) => entry.reason === "git internals" && entry.path.endsWith("/.git")
    ),
    `a .git directory was read instead of skipped: ${JSON.stringify(excluded.observed.code.excluded)}`
  );
  assert.ok(
    excluded.observed.code.excluded.some((entry) => entry.reason === "credentials"),
    `a credential was not excluded: ${JSON.stringify(excluded.observed.code.excluded)}`
  );

  // Actual installed code does move it, and says which package moved.
  writeFileSync(join(packageDir, "extension.mjs"), "export default function () { return 2; }\n");
  const drifted = await diagnose(h, planId);
  assert.equal(drifted.state, "drifted");
  assert.equal(drifted.launchable, false);
  const moved = drifted.drift.filter((entry) => entry.component === "code");
  assert.ok(moved.length > 0, "edited installed code was not reported as drift");
  assert.ok(
    moved.some((entry) => entry.path.startsWith("/lock/code/packages/")),
    `the changed package is not named: ${JSON.stringify(moved)}`
  );
  assert.ok(
    !JSON.stringify(drifted).includes(secret),
    "a credential value reached a reported fingerprint or diagnosis"
  );
  h.record("exclusions-and-code-drift", {
    excludedPaths: excluded.lock.code.excluded,
    excludedCount: excluded.lock.code.excludedCount,
    stateWithExclusions: excluded.state,
    stateAfterCodeEdit: drifted.state,
    namedPackages: moved.filter((entry) => entry.path.includes("/packages/")).map((entry) => entry.path),
    secretLeaked: false,
  });
});

test("a changed selected resource is drift, never an accepted update", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "lock-resource", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const { planId } = await installSource(h, git.sourceAt(git.commits[0]), "resource");
  const { record } = stored(h, planId);
  const skill = join(record.attempts.at(-1).agentDir, "npm", "node_modules", "wardrobe-fixture", "skills", "review", "SKILL.md");

  writeFileSync(skill, "---\nname: fixture-review\ndescription: changed.\n---\n\n# changed\n");

  const report = await diagnose(h, planId);
  assert.equal(report.state, "drifted");
  const resources = report.drift.filter((entry) => entry.component === "resources");
  assert.equal(resources.length, 1, JSON.stringify(report.drift));
  assert.match(resources[0].path, /skills\/review\/SKILL\.md/);
  assert.match(resources[0].detail, /content changed/);

  // Removing it entirely is also drift, and is reported as missing rather than
  // as a revision that may be reconstructed.
  rmSync(skill);
  const removed = await diagnose(h, planId);
  assert.equal(removed.state, "drifted");
  assert.ok(
    removed.drift.some(
      (entry) => entry.component === "resources" && /no longer there/.test(entry.detail)
    ),
    JSON.stringify(removed.drift)
  );
  assert.ok(
    removed.unverified.some((entry) => /not present/.test(entry.reason)),
    `a missing resource was not reported: ${JSON.stringify(removed.unverified)}`
  );
  h.record("selected-resource-drift", {
    afterEdit: report.state,
    afterRemoval: removed.state,
    details: removed.drift.filter((entry) => entry.component === "resources"),
  });
});

test("a missing revision is not reported as the original exact revision", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "lock-missing", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const { confirmed, planId } = await installSource(h, git.sourceAt(git.commits[0]), "missing");
  const { record } = stored(h, planId);
  const attemptDir = record.attempts.at(-1).agentDir;

  rmSync(attemptDir, { recursive: true, force: true });
  const report = await diagnose(h, planId);

  assert.equal(report.state, "missing");
  assert.equal(report.recorded, "available", "the recorded state was rewritten by a failure");
  assert.match(report.detail, /does not exist/);
  assert.equal(report.launchable, false);
  assert.equal(
    existsSync(attemptDir),
    false,
    "diagnosing a missing revision rebuilt the tree it could not verify"
  );
  // What was reinstalled in place, if anything, was a new attempt — never this
  // revision quietly becoming itself again.
  const retry = await wardrobe(h, `install ${git.sourceAt(git.commits[0])} --confirm ${confirmed.plan.digest}`);
  assert.equal(retry.ok, true, retry.text);
  assert.equal(retry.state, "available");
  assert.equal(retry.staging.alreadyAvailable, false, "a missing revision was reused in place");
  assert.notEqual(retry.staging.agentDir, attemptDir);
  h.record("missing-revision-is-not-the-original", {
    state: report.state,
    recorded: report.recorded,
    rebuilt: existsSync(attemptDir),
    retryAttempt: retry.staging.attempt,
  });
});

test("a newer runtime, a tampered plan and an unsupported range follow their actual compatibility contracts", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "lock-baseline", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const { planId } = await installSource(h, git.sourceAt(git.commits[0]), "baseline");
  const { record, plan, planPath } = stored(h, planId);
  const attempt = record.attempts.at(-1);

  // A newer Pi alone does not invalidate a revision; an actual platform
  // mismatch remains unsupported even when the resource tree is unchanged.
  const otherBaseline = {
    ...record,
    attempts: [
      {
        ...attempt,
        lock: { ...attempt.lock, baseline: { ...attempt.lock.baseline, pi: "0.9.0", platform: "plan9" } },
      },
    ],
  };
  const moved = await diagnoseRevision(otherBaseline, { env: measuringEnv(h), plan });
  assert.equal(moved.state, "unverified");
  assert.equal(moved.recorded, "available");
  assert.deepEqual(moved.drift, []);
  assert.equal(
    moved.unverified.some((entry) => /this host runs pi/.test(entry.reason)),
    false,
    JSON.stringify(moved.unverified)
  );
  assert.ok(moved.unverified.some((entry) => /platform/.test(entry.detail)));

  // A stored plan that no longer hashes to its own digest is configuration
  // drift: the approval this revision was built from cannot be trusted.
  writeFileSync(
    planPath,
    `${JSON.stringify({ ...plan, runtime: { thinking: "off" } }, null, 2)}\n`
  );
  const tampered = await diagnose(h, planId);
  assert.equal(tampered.state, "drifted");
  assert.ok(
    tampered.drift.some((entry) => entry.path === "/plan/digest"),
    JSON.stringify(tampered.drift)
  );
  assert.ok(tampered.drift.some((entry) => /no longer hashes to its digest/.test(entry.detail)));

  // Range resolution itself reports "unknown" rather than "satisfied".
  assert.equal(satisfies(">=99.0.0", "1.1.0"), false);
  assert.equal(satisfies(">=1.1.0 <2.0.0", "1.1.0"), true);
  assert.equal(satisfies("^1.1.0", "2.0.0"), false);
  assert.equal(satisfies("~1.1.0", "1.1.9"), true);
  assert.equal(satisfies("~1.1.0", "1.2.0"), false);
  assert.equal(satisfies("1.2.x", "1.2.9"), true);
  assert.equal(satisfies("1.2.x", "1.3.0"), false);
  assert.equal(satisfies("latest", "1.1.0"), null);
  assert.equal(satisfies("1.x", "1.9.9"), true);
  assert.equal(satisfies("1.x", "2.0.0"), false);

  // And a revision whose declared range excludes this Pi build is unsupported
  // rather than available, even though nothing about its tree is wrong.
  const future = await gitPreset(h, "lock-future", { compatibility: { pi: ">=99.0.0" } });
  const installed = await installSource(h, future.source, "future");
  const unsupported = await diagnose(h, installed.planId);
  assert.equal(unsupported.state, "unverified");
  assert.deepEqual(unsupported.drift, []);
  assert.ok(
    unsupported.unverified.some(
      (entry) => entry.component === "compatibility" && /does not satisfy/.test(entry.reason)
    ),
    JSON.stringify(unsupported.unverified)
  );
  h.record("baseline-tamper-and-unsupported", {
    movedBaseline: { state: moved.state, unverified: moved.unverified.length },
    tamperedPlan: tampered.state,
    unsupported: { state: unsupported.state, unverified: unsupported.unverified },
  });
});

test("separate approved revisions keep independently owned storage", async () => {
  const h = harness();
  await installManager(h);
  const movedPreset = {
    schemaVersion: 1,
    id: "locked-git-moved",
    name: "Locked Git Moved",
    version: "2.0.0",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    packages: { itself: { source: "." } },
    resources: [{ package: "itself", kind: "skills", include: ["skills/a/SKILL.md"] }],
  };
  // One repository with two commits: installing the second must never mutate
  // the revision the first commit produced.
  const first = await gitPreset(h, "lock-first", {}, [
    {
      message: "second",
      files: {
        "preset.json": `${JSON.stringify(movedPreset)}\n`,
        "skills/a/SKILL.md": "---\nname: a\ndescription: a moved\n---\n\n# moved\n",
        "package.json": `${JSON.stringify({ name: "locked-lock-first", version: "2.0.0" })}\n`,
      },
    },
  ]);
  const second = await gitPreset(h, "lock-second");
  const a = await installSource(h, first.source, "first");
  const b = await installSource(h, second.source, "second");
  assert.notEqual(a.planId, b.planId, "two sources produced one revision");

  const left = await diagnose(h, a.planId);
  const right = await diagnose(h, b.planId);
  assert.equal(left.state, "available", JSON.stringify(left.drift));
  assert.equal(right.state, "available", JSON.stringify(right.drift));
  assert.notEqual(left.latest.agentDir, right.latest.agentDir, "two revisions share a directory");
  assert.notEqual(left.lock.digest, right.lock.digest);
  assert.deepEqual(left.lock.code.roots, ["git"], "a git checkout is not locked as installed code");
  assert.equal(right.lock.resources.length, 1);

  // A native same-repo ref never mutates an existing revision.
  const moved = first.git;
  const next = await installSource(h, moved.sourceAt(moved.commits[1]), "moved");

  const stillThere = await diagnose(h, a.planId);
  assert.equal(stillThere.state, "available", "installing a new ref mutated an existing revision");
  assert.equal(stillThere.latest.agentDir, left.latest.agentDir, "an existing revision was reinstalled in place");
  assert.equal(stillThere.lock.digest, left.lock.digest);
  const third = await diagnose(h, next.planId);
  assert.equal(third.state, "available");
  assert.notEqual(third.revision, a.planId);
  assert.notEqual(third.latest.agentDir, left.latest.agentDir);
  h.record("independent-revision-storage", {
    revisions: [a.planId, b.planId, next.planId],
    agentDirs: [left.latest.agentDir, right.latest.agentDir, third.latest.agentDir],
    firstStillAvailable: stillThere.state,
    lockDigests: [left.lock.digest, right.lock.digest, third.lock.digest],
  });
});

test("a drifted revision is replaced by a fresh attempt, never handed back", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "lock-supersede", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset({ id: "supersede", name: "Supersede" }))}\n` } },
  ]);
  const source = git.sourceAt(git.commits[0]);
  const { planId } = await installSource(h, source, "supersede");
  const first = await diagnose(h, planId);
  assert.equal(first.state, "available");

  // An unchanged revision is reused, and says so rather than reinstalling.
  const digest = (await wardrobe(h, `install ${source}`)).plan.digest;
  const reused = await wardrobe(h, `install ${source} --confirm ${digest}`);
  assert.equal(reused.ok, true, reused.text);
  assert.equal(reused.staging.alreadyAvailable, true, "an intact revision was reinstalled in place");
  assert.equal(reused.staging.lockDigest, first.lock.digest);

  // Now change the installed tree behind the manager's back. The record still
  // says available; the measurement does not.
  const { record } = stored(h, planId);
  const packageDir = join(record.attempts.at(-1).agentDir, "npm", "node_modules", "wardrobe-fixture");
  writeFileSync(join(packageDir, "extension.mjs"), "export default function () { return 4; }\n");
  const drifted = await diagnose(h, planId);
  assert.equal(drifted.state, "drifted");

  const replaced = await wardrobe(h, `install ${source} --confirm ${digest}`);
  assert.equal(replaced.ok, true, replaced.text);
  assert.equal(replaced.staging.alreadyAvailable, false, "a drifted revision was handed back as available");
  assert.equal(replaced.staging.attempt, drifted.latest.attempt + 1, "the drifted attempt was replaced in place");
  assert.deepEqual(replaced.staging.superseded, {
    attempt: drifted.latest.attempt,
    state: "drifted",
    drift: drifted.drift.length,
    unverified: drifted.unverified.length,
  });
  assert.match(replaced.text, /was replaced, not reused: it measured drifted/);
  assert.notEqual(replaced.staging.agentDir, drifted.latest.agentDir);
  // The old directory is left exactly as it was: nothing is rolled back.
  assert.ok(existsSync(drifted.latest.agentDir), "the drifted attempt was removed");
  const after = await diagnose(h, planId);
  assert.equal(after.state, "available", JSON.stringify(after.drift));
  h.record("drifted-revision-is-replaced", {
    superseded: replaced.staging.superseded,
    newAttempt: replaced.staging.attempt,
    oldDirectoryRetained: existsSync(drifted.latest.agentDir),
    stateAfter: after.state,
  });
});

test("a declared platform outside this host is unsupported, not available", async () => {
  const h = harness();
  await installManager(h);
  const wrong = await gitPreset(h, "lock-platform", {
    compatibility: { pi: ">=1.1.0 <2.0.0", platforms: ["plan9-sparc"] },
  });
  const installed = await installSource(h, wrong.source, "platform");
  const report = await diagnose(h, installed.planId);
  assert.equal(report.state, "unverified");
  assert.deepEqual(report.drift, []);
  assert.ok(
    report.unverified.some(
      (entry) => entry.component === "compatibility" && /not among the declared platforms/.test(entry.reason)
    ),
    JSON.stringify(report.unverified)
  );

  // The matching platform verifies, so the check is the declaration and not a
  // blanket refusal.
  const right = await gitPreset(h, "lock-platform-ok", {
    compatibility: { pi: ">=1.1.0 <2.0.0", platforms: [`${process.platform}-${process.arch}`] },
  });
  const supported = await installSource(h, right.source, "platform-ok");
  const ok = await diagnose(h, supported.planId);
  assert.equal(ok.state, "available", JSON.stringify(ok.unverified));
  h.record("declared-platforms", {
    wrongPlatform: report.unverified.find((entry) => entry.component === "compatibility")?.reason,
    supportedPlatform: ok.state,
  });
});

test("status and doctor report intended configuration beside observed state", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "lock-commands", [
    { message: "add", files: { "preset.json": `${JSON.stringify(npmPreset())}\n` } },
  ]);
  const { planId } = await installSource(h, git.sourceAt(git.commits[0]), "commands");

  const before = await wardrobe(h, `status ${planId}`);
  assert.equal(before.ok, true, before.text);
  assert.equal(before.state, "available");
  assert.equal(before.selected.revision, planId);
  assert.equal(before.selected.recorded, "available");
  assert.equal(before.selected.launchable, false);
  assert.match(before.selected.lock, /^[0-9a-f]{64}$/);
  assert.match(before.text, /launchable: false/);
  assert.match(before.text, /installed revisions:/);

  const clean = await wardrobe(h, `doctor ${planId}`);
  assert.equal(clean.ok, true, clean.text);
  assert.equal(clean.state, "available");
  assert.equal(clean.revisions[0].lock.resources.length, 1);
  assert.match(clean.text, /configuration [0-9a-f]{16}/);
  assert.match(clean.text, /baseline pi /);

  // Change the installed tree behind the manager's back.
  const { record } = stored(h, planId);
  writeFileSync(
    join(record.attempts.at(-1).agentDir, "npm", "node_modules", "wardrobe-fixture", "extension.mjs"),
    "export default function () { return 3; }\n"
  );

  const after = await wardrobe(h, `status ${planId}`);
  assert.equal(after.ok, true, after.text);
  assert.equal(after.state, "drifted");
  assert.equal(after.selected.state, "drifted");
  assert.equal(after.selected.recorded, "available", "the recorded state was lost");
  assert.notEqual(after.selected.state, "available");
  assert.ok(after.selected.drift > 0);
  assert.match(after.text, /\(recorded available\)/);

  const diagnosis = await wardrobe(h, `doctor ${planId}`);
  assert.equal(diagnosis.state, "drifted");
  assert.match(diagnosis.text, /drift \[code\]/);
  assert.doesNotMatch(diagnosis.text, /state: available/);
  assert.doesNotMatch(diagnosis.text, /healthy: true/);

  // list and show report the same measured truth, and neither invents a state.
  const listed = await wardrobe(h, "list");
  assert.equal(listed.revisions.find((entry) => entry.revision === planId).state, "drifted");
  assert.match(listed.text, /drift \d+/);
  // `show` addresses a declared preset by its source-qualified identity, so a
  // local declaration that shares an id with an installed revision reports no
  // revision of its own rather than borrowing another source's state.
  const source = join(h.sandbox.work, "local-presets");
  writePreset(source, "locked", npmPreset());
  const shown = await wardrobe(h, "show locked", { extraEnv: { WARDROBE_PRESET_DIRS: source } });
  assert.equal(shown.ok, true, shown.text);
  assert.deepEqual(shown.revisions, [], "a local declaration claimed another source's revision");
  assert.match(shown.text, /installed revisions: \(none\)/);
  assert.equal(shown.installed, false);
  assert.equal(shown.active, false);
  h.record("status-and-doctor-truth", {
    before: { state: before.state, recorded: before.revisions[0].recorded },
    after: {
      state: after.state,
      recorded: after.revisions[0].recorded,
      drift: after.revisions[0].drift,
    },
    doctorText: diagnosis.text.split("\n").filter((line) => /state:|drift \[/.test(line)),
  });
});

test("an unknown revision selector is refused with the names that do exist", async () => {
  const h = harness();
  await installManager(h);
  // A name of its own: the agent directory is shared across this file, and an
  // ambiguous name is refused rather than guessed.
  const git = await repo(h, "lock-selector", [
    {
      message: "add",
      files: { "preset.json": `${JSON.stringify(npmPreset({ id: "selector", name: "Selector" }))}\n` },
    },
  ]);
  const { planId } = await installSource(h, git.sourceAt(git.commits[0]), "selector");

  const unknown = await wardrobe(h, "doctor no-such-revision");
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /no installed revision matches/);
  assert.match(unknown.text, new RegExp(planId));

  // A preset name resolves to its revision, so a user need not know ids.
  const byIdentity = await wardrobe(h, "status Selector");
  assert.equal(byIdentity.ok, true, byIdentity.text);
  assert.equal(byIdentity.selected.revision, planId);
  assert.equal(byIdentity.state, "available");

  // With no selector the whole store is summarised, and the summary may never
  // look healthier than the least healthy revision in it.
  const empty = await wardrobe(h, "status");
  assert.equal(empty.ok, true, empty.text);
  assert.equal(empty.selected, null);
  assert.ok(empty.revisions.length > 1, "the store holds only one revision");
  const states = empty.revisions.map((entry) => entry.state);
  for (const state of ["drifted", "failed", "missing", "unverified"]) {
    if (states.includes(state)) {
      assert.equal(empty.state, state, "the summary hid a less healthy revision");
      break;
    }
  }
  h.record("selector-resolution", {
    unknownRefusal: unknown.text.split("\n")[0],
    byIdentity: byIdentity.selected.revision,
  });
});
