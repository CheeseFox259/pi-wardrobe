// Harness cleanup guarantees: a failing check must not leave a temporary root,
// a live child process or a transport running behind it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createFixtureHarness } from "../fixtures/index.mjs";

test("a failed operation still releases every owned resource", async () => {
  const harness = await createFixtureHarness({ label: "self-test-cleanup-on-failure" });
  const { root } = harness.sandbox;
  const origin = harness.server.origin;
  assert.ok(existsSync(root), "the temporary root should exist while running");

  // A real child process, so process reclamation is exercised too.
  const child = harness.sandbox.runner.fork(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { cwd: harness.sandbox.project, env: harness.sandbox.childEnv() }
  );
  const exited = new Promise((resolve) => child.on("close", resolve));
  assert.equal(harness.sandbox.runner.liveChildren, 1);

  await assert.rejects(
    async () => {
      throw new Error("simulated check failure");
    },
    /simulated check failure/
  );
  harness.evidence.recordFailure("simulated-check", new Error("simulated check failure"));
  await harness.dispose();

  assert.equal(existsSync(root), false, "temporary root survived dispose");
  assert.equal(harness.sandbox.runner.liveChildren, 0, "a child process survived dispose");
  await assert.rejects(fetch(`${origin}/`), "the loopback transport is still serving");
  assert.equal(
    await exited.then((code) => (code === null ? "signal" : code)),
    "signal",
    "the spawned child did not terminate on signal"
  );

  const written = harness.evidence.write();
  const payload = JSON.parse(readFileSync(written.json, "utf8"));
  assert.equal(payload.failures, 1);
  assert.ok(
    payload.records.some((record) => record.name === "simulated-check"),
    "the failure was not recorded in the evidence"
  );
  assert.ok(!JSON.stringify(payload).includes(root), "evidence leaked a temporary path");
});

test("dispose is idempotent and safe to call twice", async () => {
  const harness = await createFixtureHarness({ label: "self-test-cleanup-idempotent" });
  const { root } = harness.sandbox;
  await harness.dispose();
  await harness.dispose();
  assert.equal(existsSync(root), false);
});
