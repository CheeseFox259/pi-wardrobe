// Shared setup for the controlled native fixture checks.
//
// One harness per test file: each file gets its own temporary root, loopback
// transports and seeded agent directories, and dispose() always runs.
import assert from "node:assert/strict";
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
