// The manager, installed and driven inside a real isolated Pi session.
//
// Asserts the four things ticket 02 promises: /wardrobe registers with no
// preset, MCP or browser baggage; a local declaration is snapshotted and
// inspected without claiming installed or active state; ambiguous short ids
// refuse; and preferences stay proposals while personal settings and auth are
// left alone.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { composedPreset, minimalCoding, writePreset } from "./support/presets.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("manager-inspection");
const MANAGER_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "packages/wardrobe"
);

/** Preset source directories inside the sandbox, one per declared source. */
function presetRoot(h, name) {
  return `${h.sandbox.root}/preset-sources/${name}`;
}

async function installManager(h) {
  const result = await h.pi.run("primary", ["install", MANAGER_DIR]);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}

/**
 * The declaration source Pi wrote for the manager.
 *
 * An unfiltered install records the source as a plain string; a filtered one
 * records an object. Both are the same declaration for our purposes.
 */
function declaredManagerSources(h) {
  return h
    .settings("primary")
    .packages.map((entry) => (typeof entry === "string" ? entry : entry.source))
    .filter((source) => source.includes("wardrobe"));
}

test("the manager installs with no preset, MCP or browser dependencies", async () => {
  const h = harness();
  const manifest = JSON.parse(readFileSync(join(MANAGER_DIR, "package.json"), "utf8"));

  assert.deepEqual(manifest.dependencies ?? {}, {}, "the manager declares dependencies");
  assert.deepEqual(manifest.scripts ?? {}, {}, "the manager declares install scripts");
  assert.deepEqual(manifest.pi.extensions, ["extensions/wardrobe.mjs"]);
  assert.deepEqual(manifest.pi.skills, [], "the manager ships no skills");
  assert.deepEqual(manifest.pi.prompts, [], "the manager ships no prompts");
  assert.deepEqual(manifest.pi.themes, [], "the manager ships no themes");

  await installManager(h);

  const declared = declaredManagerSources(h);
  assert.equal(declared.length, 1, `expected exactly one declared package, got ${JSON.stringify(declared)}`);
  h.record("manager-installs-alone", {
    declaredSource: declared[0],
    dependencies: 0,
    installScripts: 0,
    resources: { skills: 0, prompts: 0, themes: 0 },
  });
});

test("a live session registers /wardrobe and nothing else", async () => {
  const h = harness();
  await installManager(h);

  // Diff against a session that has the manager's driver but not the manager,
  // so "no extra commands" is measured rather than assumed.
  const without = await h.pi.rpc("baseline");
  let baselineCommands;
  try {
    baselineCommands = await without.commandNames();
  } finally {
    await without.close();
  }

  const session = await h.pi.rpc("primary");
  try {
    const names = await session.commandNames();
    assert.ok(names.includes("wardrobe"), `/wardrobe not registered: ${names.join(", ")}`);
    const added = names.filter((name) => !baselineCommands.includes(name));
    assert.deepEqual(added, ["wardrobe"], `unexpected commands from the manager: ${added.join(", ")}`);
    h.record("wardrobe-command-registered", { addedCommands: added });
  } finally {
    await session.close();
  }
});

test("list is read-only and never claims installed or active", async () => {
  const h = harness();
  await installManager(h);
  const source = presetRoot(h, "local");
  writePreset(source, "minimal-coding", minimalCoding());
  const before = h.snapshotAgent("primary");

  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });
  try {
    await session.command("wardrobe list");
    const [result] = await session.readCustomEntries(RESULT_TYPE);
    assert.ok(result, "the manager recorded no result entry");
    assert.equal(result.data.ok, true, result.data.text);
    assert.equal(result.data.presets.length, 1);
    const preset = result.data.presets[0];
    assert.equal(preset.id, "minimal-coding");
    assert.equal(preset.version, "1.0.0");
    assert.equal(preset.state, "discovered");
    assert.equal(result.data.installed, false);
    assert.equal(result.data.active, false);
    assert.equal(preset.snapshot, null, "list wrote a snapshot it was not asked for");
    assert.equal(
      existsSync(join(h.agentPath("primary"), "wardrobe", "snapshots")),
      false,
      "list created a snapshot store"
    );
    h.record("list-is-read-only", {
      preset: `${preset.source}#${preset.id}`,
      state: preset.state,
      installed: result.data.installed,
      active: result.data.active,
      snapshot: preset.snapshot,
    });

    const after = h.snapshotAgent("primary");
    assert.equal(after["unrelated.txt"], before["unrelated.txt"]);
    assert.equal(after["auth.json"], before["auth.json"]);
    h.record("inspection-preserves-personal-state", { unchanged: ["auth.json", "unrelated.txt"] });
  } finally {
    await session.close();
  }
});

test("show and explain report declared fields, origins and proposals", async () => {
  const h = harness();
  await installManager(h);
  const source = presetRoot(h, "composed");
  writePreset(source, "minimal-coding", composedPreset({ id: "minimal-coding" }));

  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });
  try {
    await session.command("wardrobe show minimal-coding");
    await session.command("wardrobe explain minimal-coding");
    const results = (await session.readCustomEntries(RESULT_TYPE)).map((entry) => entry.data);
    assert.equal(results.length, 2);

    const shown = results.find((entry) => entry.command === "show");
    assert.equal(shown.ok, true, shown.text);
    assert.equal(shown.installed, false);
    assert.equal(shown.active, false);
    assert.match(shown.text, /installed: false/);
    assert.match(shown.text, /active: false/);

    const explained = results.find((entry) => entry.command === "explain");
    assert.equal(explained.ok, true, explained.text);
    const byPath = Object.fromEntries(explained.fields.map((field) => [field.path, field]));
    for (const field of explained.fields) {
      assert.ok(field.origin, `${field.path} has no origin`);
    }
    assert.equal(byPath["/packages"].kind, "composition");
    assert.equal(byPath["/runtime"].kind, "preference");
    assert.equal(byPath["/runtime"].applied, false, "preferences were reported as applied");
    // Nested declared fields keep their own provenance, not just the container.
    assert.equal(byPath["/runtime/thinking"]?.value, "high");
    assert.equal(byPath["/runtime/thinking"]?.applied, false);
    assert.equal(byPath["/runtime/tools/enable/0"]?.value, "bash");
    assert.equal(byPath["/compatibility/pi"]?.kind, "metadata");
    assert.equal(byPath["/packages/@scope/tools/source"]?.value, "npm:@scope/tools@1.2.3");
    // Inspecting captures the snapshot; list did not.
    assert.ok(existsSync(join(shown.preset.snapshotDir, "definition.json")));
    const captured = JSON.parse(
      readFileSync(join(shown.preset.snapshotDir, "definition.json"), "utf8")
    );
    assert.deepEqual(captured, shown.definition, "the snapshot is not what was inspected");
    assert.ok(
      explained.proposals.every((proposal) => proposal.includes("would propose")),
      `proposals not marked as proposals: ${JSON.stringify(explained.proposals)}`
    );
    assert.match(explained.text, /proposal, not applied/);
    h.record("explain-reports-fields-and-proposals", {
      fields: explained.fields.map((field) => `${field.path}:${field.kind}`),
      proposals: explained.proposals.length,
      installed: explained.installed,
      active: explained.active,
    });
  } finally {
    await session.close();
  }
});

test("an invalid declaration is refused with its path and the rest still lists", async () => {
  const h = harness();
  await installManager(h);
  const source = presetRoot(h, "invalid");
  writePreset(source, "broken", minimalCoding({ id: "broken", credentials: { apiKey: "sk" } }));
  writePreset(source, "fine", minimalCoding({ id: "fine" }));

  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });
  try {
    await session.command("wardrobe list");
    const [result] = await session.readCustomEntries(RESULT_TYPE);
    const data = result.data;
    assert.equal(data.ok, true);
    assert.deepEqual(
      data.presets.map((preset) => preset.id).sort(),
      ["fine"]
    );
    assert.equal(data.rejected.length, 1);
    assert.match(data.rejected[0].text, /\/credentials/);
    h.record("invalid-declaration-refused-not-fatal", {
      accepted: data.presets.map((preset) => preset.id),
      rejected: data.rejected.length,
      rejection: data.rejected[0].text,
    });
  } finally {
    await session.close();
  }
});

test("an unresolved resource alias refuses only its own declaration", async () => {
  const h = harness();
  await installManager(h);
  const source = presetRoot(h, "missing-resource");
  // Selects a resource from a package no layer declares. Alias resolution runs
  // across the inherited chain, so the refusal happens when it is composed.
  writePreset(
    source,
    "broken-resources",
    composedPreset({
      id: "broken-resources",
      packages: {},
      resources: [{ package: "@scope/absent", include: ["skills/x/SKILL.md"] }],
    })
  );
  writePreset(source, "healthy", minimalCoding({ id: "healthy" }));

  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });
  try {
    await session.command("wardrobe list");
    await session.command("wardrobe explain broken-resources");
    await session.command("wardrobe explain healthy");
    const results = (await session.readCustomEntries(RESULT_TYPE)).map((entry) => entry.data);

    const listed = results.find((entry) => entry.command === "list");
    assert.equal(listed.ok, true, "a bad resource aborted the whole listing");
    assert.deepEqual(
      listed.presets.map((preset) => preset.id).sort(),
      ["broken-resources", "healthy"]
    );

    const broken = results.find((entry) => entry.command === "explain" && !entry.ok);
    assert.ok(broken, "an unresolved alias composed successfully");
    assert.match(broken.text, /\/resources\/0\/package/);
    assert.match(broken.text, /not declared in \/packages/);
    assert.match(broken.text, /broken-resources\/preset\.json/);

    const healthy = results.find((entry) => entry.command === "explain" && entry.ok);
    assert.equal(healthy.definition.name, "Minimal Coding");
    h.record("unresolved-alias-refused-only-its-preset", {
      listed: listed.presets.map((preset) => preset.id),
      refusal: broken.text,
    });
  } finally {
    await session.close();
  }
});

test("a short id shared by two sources refuses rather than guessing", async () => {
  const h = harness();
  await installManager(h);
  const first = presetRoot(h, "first");
  const second = presetRoot(h, "second");
  writePreset(first, "minimal-coding", minimalCoding({ name: "Minimal Coding (first)" }));
  writePreset(second, "minimal-coding", minimalCoding({ name: "Minimal Coding (second)" }));

  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_PRESET_DIRS: `${first},${second}` },
  });
  try {
    await session.command("wardrobe list");
    await session.command("wardrobe show minimal-coding");
    await session.command(`wardrobe show ${first}#minimal-coding`);
    const results = (await session.readCustomEntries(RESULT_TYPE)).map((entry) => entry.data);

    const listed = results.find((entry) => entry.command === "list");
    assert.equal(listed.presets.length, 2);

    const ambiguous = results.find((entry) => entry.command === "show" && !entry.ok);
    assert.ok(ambiguous, "the ambiguous short id resolved instead of refusing");
    assert.match(ambiguous.text, /ambiguous/);
    assert.match(ambiguous.text, /qualify the selector with its source/);
    for (const candidate of [first, second]) {
      assert.ok(
        ambiguous.text.includes(candidate),
        `refusal did not name the candidate ${candidate}: ${ambiguous.text}`
      );
    }

    const qualified = results.filter((entry) => entry.command === "show" && entry.ok);
    assert.equal(qualified.length, 1);
    assert.equal(qualified[0].definition.name, "Minimal Coding (first)");
    h.record("ambiguous-short-id-refuses", {
      sources: [first, second],
      refusal: ambiguous.text,
      qualifiedResolved: qualified[0].preset.name,
    });
  } finally {
    await session.close();
  }
});

test("an unknown subcommand refuses and names the available ones", async () => {
  const h = harness();
  await installManager(h);
  const session = await h.pi.rpc("primary");
  try {
    await session.command("wardrobe bogus");
    const [result] = await session.readCustomEntries(RESULT_TYPE);
    assert.equal(result.data.ok, false);
    assert.match(result.data.text, /unknown \/wardrobe subcommand/);
    assert.match(result.data.text, /available: list, show, explain/);
    h.record("unknown-subcommand-refuses", { text: result.data.text });
  } finally {
    await session.close();
  }
});

test("a preset run never touches personal auth or unrelated preferences", async () => {
  const h = harness();
  await installManager(h);
  const source = presetRoot(h, "personal");
  writePreset(source, "minimal-coding", composedPreset({ id: "minimal-coding" }));
  const before = h.snapshotAgent("primary");

  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });
  try {
    await session.command("wardrobe list");
    await session.command("wardrobe show minimal-coding");
    await session.command("wardrobe explain minimal-coding");
    // Declared preferences are proposals, so the running session is unchanged.
    await session.command("fixture-state");
  } finally {
    await session.close();
  }

  const after = h.snapshotAgent("primary");
  assert.equal(after["auth.json"], before["auth.json"], "auth store changed");
  assert.equal(after["unrelated.txt"], before["unrelated.txt"], "unrelated file changed");
  const settings = h.settings("primary");
  assert.equal(settings.fixtureUserChoice, "preserve-me", "a declared preference reached settings");
  assert.equal(settings.theme, "dark", "the active theme preference changed");
  assert.equal(settings.defaultThinkingLevel, "medium", "the active thinking preference changed");
  h.record("preferences-remain-proposals", {
    unchangedFiles: ["auth.json", "unrelated.txt"],
    theme: settings.theme,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    fixtureUserChoice: settings.fixtureUserChoice,
  });
});
