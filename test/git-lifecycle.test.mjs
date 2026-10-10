// Native Git installation against the controlled Bare Git source.
//
// Covers: both commits addressable at a full SHA over a Pi-supported Git URL,
// real clone and dependency-script evidence, persistent same-repository ref
// collision, and refusal of a nonexistent ref without disturbing the prior
// checkout.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("git-lifecycle");

test("both commits are addressable by a full SHA through a Pi Git URL", async () => {
  const h = harness();
  for (const revision of ["v1", "v2"]) {
    assert.match(h.git.commits[revision], /^[0-9a-f]{40}$/);
  }
  assert.notEqual(h.git.commits.v1, h.git.commits.v2);
  for (const revision of ["v1", "v2"]) {
    assert.match(
      h.git.sourceFor(revision),
      /^git:http:\/\/127\.0\.0\.1:\d+\/git\/wardrobe-git-fixture\.git@[0-9a-f]{40}$/
    );
  }
  h.record("git-source-addressable", h.git.commits);
});

test("native install clones the first commit and runs its dependency script", async () => {
  const h = harness();
  const source = h.git.sourceFor("v1");

  await h.pi.runOk("primary", ["install", source]);

  const checkout = h.gitCheckout("primary");
  assert.ok(checkout, "no native checkout was created");
  assert.ok(existsSync(join(checkout, ".git")), "install did not clone a repository");
  assert.equal(readFileSync(join(checkout, "revision.txt"), "utf8"), "v1\n");

  const markers = h.markerEvents().filter((event) => event.source === "git");
  assert.ok(
    markers.some((event) => event.revision === "v1" && event.version === "1.0.0"),
    `expected a v1 dependency marker, saw ${JSON.stringify(markers)}`
  );
  h.record("git-native-install", {
    source,
    checkoutRelative: checkout.replace(h.sandbox.agentPath("primary"), "<agentDir>"),
    revision: "v1",
    realClone: true,
  });
});

test("a second commit reuses the same persistent checkout path", async () => {
  const h = harness();
  const firstCheckout = h.gitCheckout("primary");
  writeFileSync(join(firstCheckout, "untracked-sentinel.txt"), "fixture owned\n");

  await h.pi.runOk("primary", ["install", h.git.sourceFor("v2")]);

  const secondCheckout = h.gitCheckout("primary");
  assert.equal(secondCheckout, firstCheckout, "a second commit created a new checkout");
  assert.equal(readFileSync(join(secondCheckout, "revision.txt"), "utf8"), "v2\n");
  assert.equal(
    existsSync(join(secondCheckout, "untracked-sentinel.txt")),
    false,
    "the untracked file inside the owned checkout survived a ref update"
  );
  const markers = h.markerEvents().filter((event) => event.source === "git");
  assert.ok(
    markers.some((event) => event.revision === "v2" && event.version === "2.0.0"),
    `expected a v2 dependency marker, saw ${JSON.stringify(markers)}`
  );
  h.record("git-ref-collision", {
    samePersistentCheckout: true,
    revision: "v2",
    untrackedFileRemoved: true,
  });
});

test("a nonexistent ref is refused and the prior checkout is retained", async () => {
  const h = harness();
  const settingsBefore = h.settingsBytes("primary");
  const checkout = h.gitCheckout("primary");
  const missingRef = "0".repeat(40);

  const failure = await h.pi.run("primary", ["install", h.git.sourceAt(missingRef)]);

  assert.notEqual(failure.code, 0, "installing a missing ref should fail");
  assert.equal(h.settingsBytes("primary"), settingsBefore);
  assert.equal(h.gitCheckout("primary"), checkout);
  assert.equal(readFileSync(join(checkout, "revision.txt"), "utf8"), "v2\n");
  h.record("git-missing-ref-refused", {
    exitCode: failure.code,
    priorSettingsRetained: true,
    priorCheckoutRetained: true,
  });
});

test("removal deletes the owned checkout and keeps the install-script marker", async () => {
  const h = harness();
  const checkout = h.gitCheckout("primary");

  await h.pi.runOk("primary", ["remove", h.git.sourceFor("v2")]);

  assert.equal(h.gitCheckout("primary"), null, "owned checkout survived removal");
  assert.deepEqual(h.settings("primary").packages, []);
  assert.ok(existsSync(h.sandbox.markerLog), "dependency-script marker was removed");
  h.record("git-owned-removal", {
    checkoutPath: checkout.replace(h.sandbox.agentPath("primary"), "<agentDir>"),
    checkoutRemoved: true,
    dependencyMarkerRetained: true,
  });
});
