// Two agent directories holding different commits of the same Git source.
//
// This is the fixture evidence that revision isolation is achievable by
// directing native operations at independent directories. It is not a claim
// about automatic restoration, inheritance, credential sharing or sandboxing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ORIGINAL_PREFERENCES, SENTINEL_NAMES } from "../fixtures/index.mjs";
import { assertSettingsMatch, useHarness } from "./support/harness.mjs";

const harness = useHarness("agent-isolation");

/** Digests of the files no fixture owns, so any change to them is a bug. */
function sentinelDigests(h, agent) {
  const snapshot = h.snapshotAgent(agent);
  return Object.fromEntries(SENTINEL_NAMES.map((name) => [name, snapshot[name]]));
}

test("two agent directories hold two commits of one source concurrently", async () => {
  const h = harness();
  const control = sentinelDigests(h, "baseline");
  const primaryBefore = sentinelDigests(h, "primary");
  const secondBefore = sentinelDigests(h, "second");

  await h.pi.runOk("primary", ["install", h.git.sourceFor("v1")]);
  await h.pi.runOk("second", ["install", h.git.sourceFor("v2")]);

  const one = h.gitCheckout("primary");
  const two = h.gitCheckout("second");
  assert.ok(one && two, "both agent directories should hold a checkout");
  assert.notEqual(one, two, "both agent directories shared one checkout path");
  assert.equal(readFileSync(join(one, "revision.txt"), "utf8"), "v1\n");
  assert.equal(readFileSync(join(two, "revision.txt"), "utf8"), "v2\n");

  assert.deepEqual(sentinelDigests(h, "primary"), primaryBefore);
  assert.deepEqual(sentinelDigests(h, "second"), secondBefore);
  assert.deepEqual(sentinelDigests(h, "baseline"), control, "the control agent changed");
  h.record("two-agent-dirs-isolate-same-git-source", {
    primaryRevision: "v1",
    secondRevision: "v2",
    distinctCheckoutPaths: true,
    sentinelFilesUnchanged: SENTINEL_NAMES,
  });
});

test("native operations in one directory do not disturb another", async () => {
  const h = harness();
  const primarySettings = h.settingsBytes("primary");
  const primaryCheckout = h.gitCheckout("primary");

  await h.pi.runOk("second", ["remove", h.git.sourceFor("v2")]);

  assert.equal(h.settingsBytes("primary"), primarySettings);
  assert.equal(h.gitCheckout("primary"), primaryCheckout);
  assert.equal(readFileSync(join(primaryCheckout, "revision.txt"), "utf8"), "v1\n");
  h.record("directory-scoped-removal", {
    removedFrom: "second",
    untouched: "primary",
  });
});

test("original preferences remain active in every seeded directory", async () => {
  const h = harness();
  for (const agent of ["baseline", "primary", "second"]) {
    assertSettingsMatch(h, agent, ORIGINAL_PREFERENCES, "original preferences");
  }
  h.record("preferences-preserved-across-agents", {
    agents: ["baseline", "primary", "second"],
    preferences: Object.keys(ORIGINAL_PREFERENCES),
  });
});
