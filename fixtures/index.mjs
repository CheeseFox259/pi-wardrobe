// Public entry point for the controlled native fixtures.
//
//   import { createFixtureHarness } from "./fixtures/index.mjs";
//
//   const harness = await createFixtureHarness({ label: "my-check" });
//   try {
//     await harness.pi.runOk("primary", ["install", harness.npm.sourceAt("1.0.0")]);
//   } finally {
//     await harness.dispose();
//   }
export { createFixtureHarness } from "./harness.mjs";
export { DEFAULT_EVIDENCE_DIR, NOT_CLAIMED } from "./lib/evidence.mjs";
export { ORIGINAL_PREFERENCES, SENTINEL_NAMES } from "./lib/sandbox.mjs";
