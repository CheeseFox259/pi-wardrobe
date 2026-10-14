// Shared setup for the controlled native fixture checks.
//
// One harness per test file: each file gets its own temporary root, loopback
// transports and seeded agent directories, and dispose() always runs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";
import { createFixtureHarness } from "../../fixtures/index.mjs";

export function useHarness(label) {
  const state = {};
  before(async () => {
    state.harness = await createFixtureHarness({ label });
  });
  after(async () => {
    await state.harness?.dispose();
  });
  return () => state.harness;
}

/** Standard environment for launching a Pi child process in an isolated test agent directory. */
export function launchEnv(h, extra = {}, agent = "primary") {
  return h.sandbox.childEnv({
    agentDir: h.agentPath(agent),
    extra: {
      WARDROBE_PI_CLI: h.runtime.cliPath,
      ...(h.server ? { WARDROBE_REGISTRY: `${h.server.origin}/npm/` } : {}),
      ...extra,
    },
  });
}

/** Read the latest fixture state recorded by the session in the staged revision directory. */
export function sessionState(revisionDir) {
  const path = join(revisionDir, "fixture-state.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

/** Read the latest fixture model request recorded in the staged revision directory. */
export function latestRequest(revisionDir) {
  const path = join(revisionDir, "fixture-request.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

/** An agent's settings without the package declarations the harness mutates. */
export function preferenceSnapshot(harness, agent) {
  const settings = { ...harness.settings(agent) };
  delete settings.packages;
  return settings;
}

/** Assert a set of settings values still matches what the harness seeded. */
export function assertSettingsMatch(harness, agent, expected, label) {
  const settings = harness.settings(agent);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(
      settings[key],
      value,
      `${label} in agent "${agent}": ${key} changed`
    );
  }
}
