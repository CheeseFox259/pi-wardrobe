// Real Pi RPC sessions observing resource registration and process lifecycle.
//
// A real Pi process is driven over its NDJSON RPC channel in `--offline` mode,
// so no model provider is ever contacted. Everything asserted here is observed
// from that live process, not simulated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("rpc-observation");

/**
 * The declaration a reviewed plan leaves behind: the package is known, but
 * every executable resource is filtered out.
 */
function seedFilteredAgent(h, name) {
  const source = h.npm.sourceAt("1.0.0");
  h.sandbox.seedAgent(name, {
    settings: {
      packages: [{ source, extensions: [], skills: [], prompts: [], themes: [] }],
    },
  });
  return source;
}

test("an unfiltered install makes its extension active at process start", async () => {
  const h = harness();
  await h.pi.runOk("primary", ["install", h.npm.sourceAt("1.0.0")]);

  const session = await h.pi.rpc("primary");
  try {
    assert.ok(
      (await session.commandNames()).includes("fixture-only"),
      "an unfiltered package should load its extension when a process starts"
    );
    assert.equal(
      h.extensionEvents().filter((event) => event.event === "load").length,
      1
    );
    h.record("unfiltered-install-loads-at-process-start", {
      // Load-bearing for review: filtering must happen before install.
      activationRequiresNoFurtherAction: true,
      extensionLoads: 1,
    });
  } finally {
    await session.close();
  }
});

test("a real RPC session observes command, tool and event registration", async () => {
  const h = harness();
  const source = seedFilteredAgent(h, "filtered");
  await h.pi.runOk("filtered", ["install", source]);

  const session = await h.pi.rpc("filtered");
  try {
    // Installed but filtered: nothing is registered in the live process.
    assert.ok(
      !(await session.commandNames()).includes("fixture-only"),
      "a filtered extension registered a command"
    );
    assert.deepEqual(session.extensionEvents(), []);
    await session.command("fixture-state");
    assert.equal(session.lastExtensionState().loads, 0);

    // Explicit activation makes the command and the tool observable.
    await session.command("fixture-enable");
    assert.ok((await session.commandNames()).includes("fixture-only"));
    await session.command("fixture-state");
    const activated = session.lastExtensionState();
    assert.ok(
      activated.tools.includes("fixture_probe"),
      `tool not registered: ${JSON.stringify(activated.tools)}`
    );
    const loadEvents = session.extensionEvents().filter((event) => event.event === "load");
    assert.equal(loadEvents.length, 1, "expected exactly one extension load");

    // Deactivation removes both, and the reload is visible as an event.
    await session.command("fixture-disable");
    assert.ok(!(await session.commandNames()).includes("fixture-only"));
    await session.command("fixture-state");
    const disabled = session.lastExtensionState();
    assert.ok(!disabled.tools.includes("fixture_probe"));
    assert.equal(disabled.loads, 1, "a reload should not reset process state");

    const shutdowns = session.extensionEvents().filter(
      (event) => event.event === "session_shutdown"
    );
    assert.ok(
      shutdowns.some((event) => event.reason === "reload"),
      `no reload shutdown observed: ${JSON.stringify(shutdowns)}`
    );
    const stderr = session.stderr.split("\n").filter(
      line => line.trim() !== "Warning: No models available. Use /login to log into a provider via OAuth or API key. See:"
    ).join("\n");
    assert.doesNotMatch(stderr, /api key|unauthorized|401/i);

    h.record("rpc-resource-registration", {
      registeredWhileFiltered: false,
      commandAfterActivation: true,
      toolAfterActivation: true,
      commandAfterDeactivation: false,
      toolAfterDeactivation: false,
      reloadShutdownObserved: true,
      extensionLoads: loadEvents.length,
      mode: "offline, no model request",
    });
  } finally {
    await session.close();
  }
});

test("each new process starts fresh and follows the persisted declaration", async () => {
  const h = harness();
  const source = seedFilteredAgent(h, "reopened");
  await h.pi.runOk("reopened", ["install", source]);

  const first = await h.pi.rpc("reopened");
  await first.command("fixture-enable");
  await first.command("fixture-state");
  assert.equal(first.lastExtensionState().loads, 1);
  const exit = await first.close();
  assert.equal(exit.code, 0, `RPC session did not exit cleanly: ${first.stderr}`);

  // The enabled filter was written to settings, so a new process loads the
  // extension at startup; its in-process counter starts from scratch.
  const second = await h.pi.rpc("reopened");
  assert.ok((await second.commandNames()).includes("fixture-only"));
  await second.command("fixture-state");
  assert.equal(
    second.lastExtensionState().loads,
    1,
    "in-memory load state carried across processes"
  );
  await second.command("fixture-disable");
  await second.close();

  // With the declaration filtered again, a third process loads nothing.
  const third = await h.pi.rpc("reopened");
  try {
    assert.ok(!(await third.commandNames()).includes("fixture-only"));
    await third.command("fixture-state");
    assert.equal(third.lastExtensionState().loads, 0);
  } finally {
    await third.close();
  }

  assert.ok(
    h.markerEvents().some((event) => event.source === "npm"),
    "install-script effects did not survive the process exits"
  );
  h.record("rpc-process-shutdown", {
    exitCode: exit.code,
    inMemoryStateResetPerProcess: true,
    activationGovernedByPersistedDeclaration: true,
    installScriptEffectsPersist: true,
  });
});
