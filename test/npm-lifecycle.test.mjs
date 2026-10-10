// Native npm installation against the controlled loopback registry.
//
// Covers: successful install, installed-inactive Extension filtering, failing
// install with external marker retention, explicit repair, and owned package
// removal with original preferences and unrelated sentinels intact.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ORIGINAL_PREFERENCES } from "../fixtures/index.mjs";
import { realPath } from "../fixtures/lib/fsx.mjs";
import {
  assertSettingsMatch,
  preferenceSnapshot,
  useHarness,
} from "./support/harness.mjs";

const harness = useHarness("npm-lifecycle");

test("native install resolves an exact version and runs its dependency script", async () => {
  const h = harness();
  const source = h.npm.sourceAt("1.0.0");

  const result = await h.pi.runOk("primary", ["install", source]);

  assert.equal(h.installedNpmVersion("primary"), "1.0.0");
  const markers = h.markerEvents().filter((event) => event.source === "npm");
  assert.ok(
    markers.some((event) => event.version === "1.0.0"),
    `expected a 1.0.0 install marker, saw ${JSON.stringify(markers)}`
  );
  assert.ok(
    markers.every((event) => realPath(event.cwd).startsWith(realPath(h.sandbox.root))),
    "install script ran outside the fixture root"
  );
  h.record("npm-native-install", {
    source,
    installedVersion: h.installedNpmVersion("primary"),
    exitCode: result.code,
    scriptMarkerRecorded: true,
  });
});

test("an unfiltered install declares the source it installed", async () => {
  const h = harness();

  assert.deepEqual(
    h.settings("primary").packages,
    [h.npm.sourceAt("1.0.0")],
    "an unfiltered install should not synthesise resource filters"
  );
  assert.deepEqual(
    h.extensionEvents(),
    [],
    "no process had started yet, so nothing should have loaded"
  );
  h.record("npm-unfiltered-install-declaration", {
    declaredSource: h.settings("primary").packages,
    note: "activation happens when a process starts; see rpc-observation",
  });
});

test("an explicit empty filter survives install and keeps resources inactive", async () => {
  const h = harness();
  const source = h.npm.sourceAt("1.0.0");
  // The shape a reviewed plan leaves behind: a declared package with every
  // executable resource filtered out.
  h.sandbox.seedAgent("staged", {
    settings: { packages: [{ source, extensions: [], skills: [], prompts: [], themes: [] }] },
  });

  await h.pi.runOk("staged", ["install", source]);

  const declared = h.settings("staged").packages.find((entry) => typeof entry !== "string");
  assert.deepEqual(declared.extensions, [], "install rewrote the inactive filter");
  assert.equal(declared.source, source);
  assert.deepEqual(h.extensionEvents(), [], "a filtered extension still loaded");
  h.record("npm-installed-inactive-filter", {
    preservedFilters: ["extensions", "skills", "prompts", "themes"],
    extensionLoadsObserved: 0,
    verifiedInALiveProcess: "test/rpc-observation.test.mjs",
  });
});

test("a failing install is refused but is not transactional", async () => {
  const h = harness();
  const settingsBefore = h.settingsBytes("primary");
  const failing = h.npm.sourceAt("2.0.0");

  const failure = await h.pi.run("primary", ["install", failing]);
  assert.notEqual(failure.code, 0, "failing install script should not succeed");

  assert.equal(
    h.settingsBytes("primary"),
    settingsBefore,
    "settings changed during a failed install"
  );
  const markers = h.markerEvents().filter((event) => event.source === "npm");
  assert.ok(
    markers.some((event) => event.version === "2.0.0"),
    "the failing script's marker should remain as evidence"
  );
  h.record("npm-failed-install-not-transactional", {
    exitCode: failure.code,
    settingsUnchanged: true,
    failedScriptMarkerRetained: true,
    residualInstalledPackage: existsSync(h.installedNpmPackage("primary")),
  });
});

test("an explicit reinstall repairs a failed staging state", async () => {
  const h = harness();

  await h.pi.runOk("primary", ["install", h.npm.sourceAt("1.0.0")]);
  assert.equal(h.installedNpmVersion("primary"), "1.0.0");
  h.record("npm-explicit-repair", {
    repairedBy: "explicit reinstall of the known-good version",
    version: h.installedNpmVersion("primary"),
    automaticRollbackClaimed: false,
  });
});

test("removal deletes owned installs and preserves everything it did not own", async () => {
  const h = harness();
  const preferencesBefore = preferenceSnapshot(h, "primary");
  const sentinelBefore = h.snapshotAgent("baseline");

  await h.pi.runOk("primary", ["remove", h.npm.sourceAt("1.0.0")]);

  assert.deepEqual(h.settings("primary").packages, []);
  assert.equal(existsSync(h.installedNpmPackage("primary")), false);
  assertSettingsMatch(h, "primary", preferencesBefore, "preferences after removal");
  for (const key of Object.keys(ORIGINAL_PREFERENCES)) {
    assert.ok(key in h.settings("primary"), `preference ${key} was dropped`);
  }
  assert.deepEqual(
    h.snapshotAgent("baseline"),
    sentinelBefore,
    "an agent directory that was never installed into changed"
  );
  assert.ok(
    existsSync(h.sandbox.markerLog),
    "install-script side effects should remain after removal"
  );
  h.record("npm-owned-removal", {
    packagesRemoved: true,
    preferencesPreserved: Object.keys(ORIGINAL_PREFERENCES),
    unrelatedSentinelPreserved: Object.keys(sentinelBefore),
    installSideEffectStillPresent: true,
  });
});

test("an untracked file inside an installed package is removed with it", async () => {
  const h = harness();
  const source = h.npm.sourceAt("1.0.0");
  await h.pi.runOk("primary", ["install", source]);
  const packageDir = h.installedNpmPackage("primary");
  writeFileSync(join(packageDir, "untracked-sentinel.txt"), "fixture owned\n");

  await h.pi.runOk("primary", ["remove", source]);
  assert.equal(existsSync(join(packageDir, "untracked-sentinel.txt")), false);
  h.record("npm-removal-clears-owned-package-directory", { sentinelRemoved: true });
});
