// Removal and release of owned revisions and explicit retention references.
//
// Every check here exercises real native cleanup through the manager in real
// isolated Pi environments. Reference checks (active leases, stale leases,
// strict pins, explicit retains, follow history) and safety confinement
// (symlink escaping, missing paths, ambiguous ownership) are verified against
// actual filesystem state.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { BindingStore } from "../packages/wardrobe/src/binding.mjs";
import { StagingStore } from "../packages/wardrobe/src/staging.mjs";
import { RetainStore } from "../packages/wardrobe/src/retain.mjs";
import {
  assertSettingsMatch,
  preferenceSnapshot,
  useHarness,
} from "./support/harness.mjs";

const harness = useHarness("owned-revision-removal");
const MANAGER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages/wardrobe");
const CLI = join(MANAGER_DIR, "bin", "wardrobe.mjs");

const repos = {};

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

function launchEnv(h, extra = {}) {
  return h.sandbox.childEnv({
    agentDir: h.agentPath("primary"),
    extra: { WARDROBE_PI_CLI: h.runtime.cliPath, ...extra },
  });
}

function withAgentDir(args, h) {
  return ["--agent-dir", h.agentPath("primary"), ...args];
}

function launch(h, args, { cwd, env, timeoutMs } = {}) {
  return h.sandbox.runner.run(process.execPath, [CLI, ...withAgentDir(args, h)], {
    cwd: cwd ?? h.sandbox.project,
    env: launchEnv(h, env),
    timeoutMs,
  });
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

async function installSource(h, source) {
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  const confirmed = await wardrobe(h, `install ${source} --confirm ${reviewed.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  return confirmed;
}

async function approvedRevisions(h, { name, id = "bound", presetName = "Bound", thinking = ["low", "high", "medium"] }) {
  const git = await repo(h, name, [
    {
      message: "first",
      files: {
        "preset.json": `${JSON.stringify({
          schemaVersion: 1,
          id,
          name: presetName,
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
          name: presetName,
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
          name: presetName,
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

function spawnExitAndWait() {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
}

test("strict-pinned revision refuses removal; deliberate re-bind allows it", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "strict-bind-repo", id: "strict-test" });
  const installed = await installSource(h, sources.first);
  const rev = installed.plan.planId;

  // Bind strict
  const bound = await wardrobe(h, `bind strict-test --mode strict --revision ${rev}`);
  assert.equal(bound.ok, true, bound.text);
  assert.equal(bound.binding.mode, "strict");

  // Attempt to remove strict-pinned revision
  const refused = await wardrobe(h, `remove strict-test --revision ${rev}`);
  assert.equal(refused.ok, false, "strict-pinned revision removal should be refused");
  assert.ok(
    refused.text.includes("strict binding") || refused.error?.message?.includes("active references"),
    `expected strict binding refusal, got: ${refused.text}`
  );
  assert.ok(
    refused.text.includes("follow") || refused.text.includes("/wardrobe bind"),
    `expected hint to change mode, got: ${refused.text}`
  );

  // Directory must still exist
  const stagingStore = new StagingStore(h.agentPath("primary"));
  const recordBefore = stagingStore.read(rev);
  assert.ok(recordBefore, "staging record should remain");
  assert.ok(existsSync(recordBefore.attempts[0].agentDir), "attempt directory should remain");

  // Deliberately re-bind to follow
  const rebound = await wardrobe(h, `bind strict-test --mode follow`);
  assert.equal(rebound.ok, true, rebound.text);
  assert.equal(rebound.binding.mode, "follow");

  // Now removal succeeds
  const removed = await wardrobe(h, `remove strict-test --revision ${rev}`);
  assert.equal(removed.ok, true, removed.text);
  assert.deepEqual(removed.removed, [rev]);
  assert.equal(existsSync(recordBefore.attempts[0].agentDir), false, "attempt directory should be deleted");
  assert.equal(stagingStore.read(rev), null, "staging record should be deleted");
});

test("active lease blocks; stale lease is diagnosed/refused; after cleared removal proceeds", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "lease-repo", id: "lease-test" });
  const installed = await installSource(h, sources.first);
  const rev = installed.plan.planId;

  const leasesDir = join(h.agentPath("primary"), "wardrobe", "leases");
  mkdirSync(leasesDir, { recursive: true });

  // 1. Active lease blocks
  writeFileSync(
    join(leasesDir, `${rev}.json`),
    `${JSON.stringify({
      revision: rev,
      kind: "run",
      runId: "live-holder",
      pid: process.pid,
      host: "localhost",
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`
  );

  const activeRefusal = await wardrobe(h, `remove lease-test --revision ${rev}`);
  assert.equal(activeRefusal.ok, false, "active lease should block removal");
  assert.ok(
    activeRefusal.text.includes("active lease") || activeRefusal.error?.message?.includes("active references"),
    `expected active lease mention, got: ${activeRefusal.text}`
  );

  // 2. Stale lease is diagnosed and refused (not silently deleted)
  const deadPid = spawnExitAndWait();
  writeFileSync(
    join(leasesDir, `${rev}.json`),
    `${JSON.stringify({
      revision: rev,
      kind: "run",
      runId: "stale-holder",
      pid: deadPid,
      host: "localhost",
      startedAt: "2020-01-01T00:00:00.000Z",
    }, null, 2)}\n`
  );

  const staleRefusal = await wardrobe(h, `remove lease-test --revision ${rev}`);
  assert.equal(staleRefusal.ok, false, "stale lease must refuse removal");
  assert.ok(
    staleRefusal.text.includes("stale lease") || staleRefusal.error?.message?.includes("stale lease"),
    `expected stale lease diagnosis, got: ${staleRefusal.text}`
  );

  const stagingStore = new StagingStore(h.agentPath("primary"));
  const record = stagingStore.read(rev);
  assert.ok(existsSync(record.attempts[0].agentDir), "attempt dir must remain while lease is stale");

  // 3. Clear stale lease and verify removal proceeds
  rmSync(join(leasesDir, `${rev}.json`), { force: true });

  const removed = await wardrobe(h, `remove lease-test --revision ${rev}`);
  assert.equal(removed.ok, true, removed.text);
  assert.equal(existsSync(record.attempts[0].agentDir), false, "attempt dir should be deleted");
  assert.equal(stagingStore.read(rev), null, "staging record should be deleted");
});

test("explicit retain blocks; release drops it without deleting transcript or changing strict mode; removal then succeeds", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "retain-repo", id: "retain-test" });
  const installed = await installSource(h, sources.first);
  const rev = installed.plan.planId;

  const stagingStore = new StagingStore(h.agentPath("primary"));
  const record = stagingStore.read(rev);
  const attemptDir = record.attempts[0].agentDir;

  // Create an explicit transcript inside the revision root
  const transcriptPath = join(attemptDir, "wardrobe", "sessions", "run-101", "transcript.jsonl");
  mkdirSync(dirname(transcriptPath), { recursive: true });
  writeFileSync(transcriptPath, '{"role":"user","content":"test conversation"}\n');

  // Retain revision explicitly
  const retainResult = await wardrobe(h, `retain retain-test --revision ${rev}`);
  assert.equal(retainResult.ok, true, retainResult.text);
  assert.equal(retainResult.retained, true);

  // Bind strict
  const bindResult = await wardrobe(h, `bind retain-test --mode strict --revision ${rev}`);
  assert.equal(bindResult.ok, true, bindResult.text);

  // Removal refused due to retain and strict binding
  const refused = await wardrobe(h, `remove retain-test --revision ${rev}`);
  assert.equal(refused.ok, false, "explicit retain should block removal");
  assert.ok(
    refused.text.includes("retention reference") || refused.error?.message?.includes("active references"),
    `expected retain mention, got: ${refused.text}`
  );

  // Release retention
  const releaseResult = await wardrobe(h, `release retain-test --revision ${rev}`);
  assert.equal(releaseResult.ok, true, releaseResult.text);
  assert.equal(releaseResult.released, true);
  assert.equal(releaseResult.stillBlockedByStrict, true);

  // Assert transcript file remains untouched
  assert.ok(existsSync(transcriptPath), "transcript file must not be deleted by release");
  assert.equal(
    readFileSync(transcriptPath, "utf8"),
    '{"role":"user","content":"test conversation"}\n',
    "transcript content must be intact"
  );

  // Assert strict mode was not silently changed
  const bindingStore = new BindingStore(h.agentPath("primary"));
  const binding = bindingStore.read(bindResult.binding.preset);
  assert.equal(binding.mode, "strict", "strict mode must not be silently altered by release");
  assert.equal(binding.revision, rev);

  // Re-bind to follow so strict pin no longer blocks removal
  await wardrobe(h, `bind retain-test --mode follow`);

  // Now removal succeeds
  const removeResult = await wardrobe(h, `remove retain-test --revision ${rev}`);
  assert.equal(removeResult.ok, true, removeResult.text);
  assert.equal(existsSync(attemptDir), false, "attempt directory deleted after successful removal");

  // Transcript destruction is honestly reported
  assert.equal(removeResult.transcriptsDestroyed?.count, 1, "must honestly report destroyed transcript count");
  assert.deepEqual(removeResult.transcriptsDestroyed?.paths, [transcriptPath], "must list destroyed transcript path");
  assert.ok(removeResult.text.includes("session transcripts destroyed: 1"), "rendered text must report transcript count");
  assert.ok(removeResult.text.includes(transcriptPath), "rendered text must report destroyed transcript path");
});

test("follow binding with migration history does not pin old revisions", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "follow-repo", id: "follow-test" });
  const first = await installSource(h, sources.first);
  const second = await installSource(h, sources.second);
  const revA = first.plan.planId;
  const revB = second.plan.planId;

  // Bind follow
  const bindResult = await wardrobe(h, "bind follow-test --mode follow");

  // Record migration history in binding store (follow migrated from revA to revB)
  const bindingStore = new BindingStore(h.agentPath("primary"));
  const binding = bindingStore.read(bindResult.binding.preset);
  binding.lastLaunched = revB;
  binding.migrations = [
    {
      at: new Date().toISOString(),
      from: revA,
      to: revB,
      mode: "follow",
      reason: "follow selected newer approved revision",
    },
  ];
  bindingStore.write(binding);

  // Removing old revision revA succeeds while follow binding remains
  const removed = await wardrobe(h, `remove follow-test --revision ${revA}`);
  assert.equal(removed.ok, true, removed.text);
  assert.deepEqual(removed.removed, [revA]);

  // Follow binding is still present
  const bindingAfter = bindingStore.read(bindResult.binding.preset);
  assert.ok(bindingAfter, "follow binding must remain");
  assert.equal(bindingAfter.mode, "follow");

  // Newer revision revB is intact
  const stagingStore = new StagingStore(h.agentPath("primary"));
  assert.equal(stagingStore.read(revA), null, "revA staging record should be removed");
  assert.ok(stagingStore.read(revB), "revB staging record should remain");
  assert.ok(existsSync(stagingStore.read(revB).attempts[0].agentDir), "revB attempt dir should remain");
});

test("remove without --revision refuses wholesale when any revision is referenced", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "wholesale-repo", id: "wholesale-test" });
  const first = await installSource(h, sources.first);
  const second = await installSource(h, sources.second);
  const rev1 = first.plan.planId;
  const rev2 = second.plan.planId;

  const stagingStore = new StagingStore(h.agentPath("primary"));
  const dir1 = stagingStore.read(rev1).attempts[0].agentDir;
  const dir2 = stagingStore.read(rev2).attempts[0].agentDir;

  // Retain rev2 only (rev1 is unreferenced)
  await wardrobe(h, `retain wholesale-test --revision ${rev2}`);

  // Attempt remove without --revision
  const refused = await wardrobe(h, "remove wholesale-test");
  assert.equal(refused.ok, false, "remove without --revision should refuse wholesale");
  assert.ok(
    refused.text.includes("cannot remove") || refused.error?.message?.includes("cannot remove"),
    `expected wholesale refusal, got: ${refused.text}`
  );

  // Assert nothing was partially deleted — BOTH directories and records remain
  assert.ok(existsSync(dir1), "unreferenced rev1 directory must NOT be partially deleted");
  assert.ok(existsSync(dir2), "referenced rev2 directory must NOT be deleted");
  assert.ok(stagingStore.read(rev1), "rev1 staging record must remain");
  assert.ok(stagingStore.read(rev2), "rev2 staging record must remain");

  // Release rev2
  await wardrobe(h, `release wholesale-test --revision ${rev2}`);

  // Now wholesale removal succeeds
  const removed = await wardrobe(h, "remove wholesale-test");
  assert.equal(removed.ok, true, removed.text);
  assert.deepEqual(removed.removed.sort(), [rev1, rev2].sort());

  assert.equal(existsSync(dir1), false, "rev1 directory deleted");
  assert.equal(existsSync(dir2), false, "rev2 directory deleted");
  assert.equal(stagingStore.read(rev1), null, "rev1 staging record deleted");
  assert.equal(stagingStore.read(rev2), null, "rev2 staging record deleted");
});

test("sibling revisions and personal environment remain intact; script effects reported not reversed", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "sibling-repo", id: "sibling-test" });
  const first = await installSource(h, sources.first);
  const second = await installSource(h, sources.second);
  const rev1 = first.plan.planId;
  const rev2 = second.plan.planId;

  const stagingStore = new StagingStore(h.agentPath("primary"));
  const dir1 = stagingStore.read(rev1).attempts[0].agentDir;
  const dir2 = stagingStore.read(rev2).attempts[0].agentDir;

  const preferencesBefore = preferenceSnapshot(h, "primary");
  const sentinelBefore = h.snapshotAgent("baseline");

  // Remove rev1
  const removed = await wardrobe(h, `remove sibling-test --revision ${rev1}`);
  assert.equal(removed.ok, true, removed.text);
  assert.equal(removed.scriptExternalEffectsReversed, false, "script effects should not be claimed reversed");
  assert.ok(removed.text.includes("script external effects: not claimed reversed"));

  // Rev1 is gone
  assert.equal(existsSync(dir1), false, "rev1 directory deleted");
  assert.equal(stagingStore.read(rev1), null, "rev1 staging record deleted");

  // Sibling rev2 is completely intact
  assert.ok(existsSync(dir2), "sibling rev2 directory must remain intact");
  assert.ok(existsSync(join(dir2, "settings.json")), "sibling rev2 settings must remain intact");
  assert.ok(stagingStore.read(rev2), "sibling rev2 staging record must remain intact");

  // Personal environment is unchanged
  assertSettingsMatch(h, "primary", preferencesBefore, "preferences after removal");
  assert.deepEqual(h.snapshotAgent("baseline"), sentinelBefore, "unrelated baseline agent must be unchanged");
  assert.ok(existsSync(h.sandbox.markerLog), "marker log must remain intact");
});

test("escaping symlink, missing path, and ambiguous ownership are refused with diagnosis", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "safety-repo", id: "safety-test" });
  const installed = await installSource(h, sources.first);
  const rev = installed.plan.planId;

  const stagingStore = new StagingStore(h.agentPath("primary"));
  const record = stagingStore.read(rev);
  const realAttemptDir = record.attempts[0].agentDir;

  // 1. Ambiguous ownership: attempting to remove with wrong preset
  const ambiguousRefusal = await wardrobe(h, `remove unrelated-preset --revision ${rev}`);
  assert.equal(ambiguousRefusal.ok, false, "ambiguous ownership must refuse");
  assert.ok(
    ambiguousRefusal.text.includes("belongs to") || ambiguousRefusal.text.includes("ambiguous") || ambiguousRefusal.text.includes("mismatch"),
    `expected ambiguous ownership diagnosis, got: ${ambiguousRefusal.text}`
  );

  // 2. Escaping symlink: attempt directory resolves outside staging root
  const escapeTarget = join(h.sandbox.root, "escaping-target");
  mkdirSync(escapeTarget, { recursive: true });
  writeFileSync(join(escapeTarget, "sentinel.txt"), "outside staging\n");

  const symlinkAttempt = join(stagingStore.root, rev, "attempt-symlink");
  symlinkSync(escapeTarget, symlinkAttempt, "dir");

  // Point record at escaping symlink
  record.attempts.push({ agentDir: symlinkAttempt, attempt: 99 });
  stagingStore.write(record);

  const escapeRefusal = await wardrobe(h, `remove safety-test --revision ${rev}`);
  assert.equal(escapeRefusal.ok, false, "escaping symlink must refuse removal");
  assert.ok(
    escapeRefusal.text.includes("escaping symlink") || escapeRefusal.text.includes("outside owned staging"),
    `expected escaping symlink diagnosis, got: ${escapeRefusal.text}`
  );
  assert.ok(existsSync(escapeTarget), "directory outside staging must NOT be deleted");

  // Clean up symlink
  rmSync(symlinkAttempt, { force: true });
  record.attempts.pop();

  // 2b. Boundary check: attempt directory pointing into sibling revision directory
  const siblingAttempt = join(stagingStore.root, "sibling-plan", "attempt-1");
  mkdirSync(siblingAttempt, { recursive: true });
  record.attempts.push({ agentDir: siblingAttempt, attempt: 99 });
  stagingStore.write(record);

  const siblingRefusal = await wardrobe(h, `remove safety-test --revision ${rev}`);
  assert.equal(siblingRefusal.ok, false, "attempt pointing into sibling directory must refuse removal");
  assert.ok(
    siblingRefusal.text.includes("escapes revision root") || siblingRefusal.text.includes("escaping symlink"),
    `expected sibling escaping diagnosis, got: ${siblingRefusal.text}`
  );
  rmSync(join(stagingStore.root, "sibling-plan"), { recursive: true, force: true });
  record.attempts.pop();

  // 3. Missing path: revision directory deleted on disk
  rmSync(realAttemptDir, { recursive: true, force: true });
  stagingStore.write(record);

  const missingRefusal = await wardrobe(h, `remove safety-test --revision ${rev}`);
  assert.equal(missingRefusal.ok, false, "missing path must refuse removal");
  assert.ok(
    missingRefusal.text.includes("missing") || missingRefusal.text.includes("does not exist"),
    `expected missing path diagnosis, got: ${missingRefusal.text}`
  );

  // 4. Path traversal: store deletion methods reject path traversal identifiers
  assert.throws(() => stagingStore.delete("../escape"), /path traversal/);
  assert.throws(() => stagingStore.delete("foo/bar"), /path traversal/);
  const retainStore = new RetainStore(h.agentPath("primary"));
  assert.throws(() => retainStore.delete("../escape"), /path traversal/);
  assert.throws(() => retainStore.delete("foo/bar"), /path traversal/);
});

test("remaining revision launches after sibling removal", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, { name: "launch-repo", id: "launch-test" });
  const first = await installSource(h, sources.first);
  const second = await installSource(h, sources.second);
  const rev1 = first.plan.planId;
  const rev2 = second.plan.planId;

  // Remove rev1
  const removed = await wardrobe(h, `remove launch-test --revision ${rev1}`);
  assert.equal(removed.ok, true, removed.text);

  // Launch remaining rev2 via standalone launcher CLI
  const launchResult = await launch(h, ["run", rev2, "--", "--mode", "rpc", "--no-session"], {
    timeoutMs: 120_000,
  });
  assert.equal(launchResult.code, 0, `launch of remaining revision failed: ${launchResult.stderr}\n${launchResult.stdout}`);
});

test("revisions are addressable by selector (id, preset name, or identity) in remove, release, retain", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, {
    name: "selector-repo",
    id: "selector-test",
    presetName: "UniqueSelectorName",
  });
  const installed = await installSource(h, sources.first);
  const rev = installed.plan.planId;

  // Retain using preset name
  const retained = await wardrobe(h, "retain selector-test --revision UniqueSelectorName");
  assert.equal(retained.ok, true, retained.text);
  assert.equal(retained.revision, rev);

  // Release using preset name
  const released = await wardrobe(h, "release selector-test --revision UniqueSelectorName");
  assert.equal(released.ok, true, released.text);
  assert.equal(released.revision, rev);

  // Remove using revision id
  const removed = await wardrobe(h, `remove selector-test --revision ${rev}`);
  assert.equal(removed.ok, true, removed.text);
  assert.deepEqual(removed.removed, [rev]);
});

test("bare --revision, corrupt staging records, and confinement store verification are safely handled", async () => {
  const h = harness();
  await installManager(h);
  const sources = await approvedRevisions(h, {
    name: "safety-extra-repo",
    id: "safety-extra",
    presetName: "SafetyExtra",
  });
  const installed = await installSource(h, sources.first);
  const rev = installed.plan.planId;
  const stagingStore = new StagingStore(h.agentPath("primary"));
  const record = stagingStore.read(rev);

  // 1. Bare --revision flag with no value refuses with argument error, NOT wholesale delete
  const bareRevisionRefusal = await wardrobe(h, "remove safety-extra --revision");
  assert.equal(bareRevisionRefusal.ok, false, "bare --revision must refuse");
  assert.ok(
    bareRevisionRefusal.text.includes("--revision flag needs a revision argument"),
    `expected argument error, got: ${bareRevisionRefusal.text}`
  );
  assert.ok(existsSync(record.attempts[0].agentDir), "directory must not be deleted on bare --revision");

  // Also check bare --revision on release and retain
  const bareReleaseRefusal = await wardrobe(h, "release safety-extra --revision");
  assert.equal(bareReleaseRefusal.ok, false);
  assert.ok(bareReleaseRefusal.text.includes("--revision flag needs a revision argument"));

  const bareRetainRefusal = await wardrobe(h, "retain safety-extra --revision");
  assert.equal(bareRetainRefusal.ok, false);
  assert.ok(bareRetainRefusal.text.includes("--revision flag needs a revision argument"));

  // 2. Corrupt staging record is diagnosed as refusal, NOT unhandled SyntaxError
  const corruptFile = join(stagingStore.root, "corrupt-rev.json");
  writeFileSync(corruptFile, "{ invalid json for corrupt record\n");

  const corruptRefusal = await wardrobe(h, "remove safety-extra --revision corrupt-rev");
  assert.equal(corruptRefusal.ok, false);
  assert.ok(
    corruptRefusal.text.includes("unreadable") || corruptRefusal.text.includes("corrupt"),
    `expected corrupt diagnosis, got: ${corruptRefusal.text}`
  );

  // 3. Wholesale remove refuses when unreadable staging record exists for that preset
  const corruptPresetFile = join(stagingStore.root, "corrupt-preset.json");
  writeFileSync(corruptPresetFile, `{"identity":{"id":"safety-extra"}, invalid json\n`);

  const wholesaleCorruptRefusal = await wardrobe(h, "remove safety-extra");
  assert.equal(wholesaleCorruptRefusal.ok, false);
  assert.ok(
    wholesaleCorruptRefusal.text.includes("unreadable") || wholesaleCorruptRefusal.text.includes("corrupt"),
    `expected wholesale refusal on corrupt record, got: ${wholesaleCorruptRefusal.text}`
  );
  assert.ok(existsSync(record.attempts[0].agentDir), "intact revision must not be deleted when corrupt record exists");

  rmSync(corruptFile, { force: true });
  rmSync(corruptPresetFile, { force: true });

  // 4. StagingStore.delete preserves record .json if confinement fails
  const escapePlanDir = join(stagingStore.root, "escape-plan");
  const escapeTarget = join(h.sandbox.root, "escape-store-target");
  mkdirSync(escapeTarget, { recursive: true });
  mkdirSync(escapePlanDir, { recursive: true });
  symlinkSync(escapeTarget, join(escapePlanDir, "bad-attempt"), "dir");

  const escapeRecordPath = join(stagingStore.root, "escape-plan.json");
  writeFileSync(escapeRecordPath, '{"planId":"escape-plan"}\n');

  assert.throws(
    () => stagingStore.delete("escape-plan"),
    /escapes/
  );
  assert.ok(existsSync(escapeRecordPath), "record .json must NOT be destroyed when confinement verification fails");

  rmSync(escapePlanDir, { recursive: true, force: true });
  rmSync(escapeRecordPath, { force: true });
});
