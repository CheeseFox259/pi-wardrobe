// Composition and provenance: Base -> Preset -> User -> Session.
//
// Layer rules are checked directly against the composer, where every input is
// visible, and end to end against real sources: a Bare Git repository served
// over loopback and a loopback npm registry, driven through a real isolated Pi
// session. Nothing is installed and no package code is imported — that
// property is what makes composition safe to review at all.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { classifyChange, compose, executableIdentity, foldResources, foldTools } from "../packages/wardrobe/src/compose.mjs";
import { resolveChain } from "../packages/wardrobe/src/inherit.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("composition-provenance");
const MANAGER_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages/wardrobe");

/** Cached sources, so each repository and package is built once per file. */
const repos = {};
const packages = {};

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

/** Run one /wardrobe invocation in a real session and return its result. */
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

function declaration(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "composed",
    name: "Composed",
    version: "1.0.0",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    ...overrides,
  };
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

async function npmPackage(h, name, versions = [{ version: "1.0.0", exitCode: 0 }]) {
  const key = `${name}:${versions.map((entry) => entry.version).join(",")}`;
  packages[key] ??= await h.npmPackage(name, versions);
  return packages[key];
}

/** A layer as composition sees it: an identity and a declaration. */
function layer(kind, identity, definition, captured = null) {
  return { kind, identity, captured, preset: { path: "preset.json" }, definition };
}

function presetLayer(definition, identity = "local#preset") {
  return layer("preset", identity, definition);
}

function baseLayer(definition, identity = "git:parent@sha#preset.json") {
  return layer("base", identity, declaration(definition));
}

function selectorsOf(composed, packageName = "tools", kind = "skills") {
  return composed.resources.find(
    (selector) => selector.package === packageName && selector.kind === kind
  );
}

test("a parent's packages, resources and preferences are inherited in order", () => {
  const composed = compose([
    baseLayer(
      {
        packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
        resources: [
          { package: "tools", kind: "skills", include: ["skills/a/SKILL.md", "skills/b/SKILL.md"] },
        ],
        persona: { append: ["from the base"] },
      },
      "git:base@sha#preset.json"
    ),
    presetLayer(
      {
        packages: {},
        resources: [{ package: "tools", kind: "skills", include: ["skills/b/SKILL.md"] }],
        persona: { append: ["from the preset"] },
      },
      "git:child@sha#preset.json"
    ),
  ]);

  assert.deepEqual(
    composed.packages.map((entry) => `${entry.alias}:${entry.canonical}@${entry.version}`),
    ["tools:npm:@scope/tools@1.0.0"]
  );
  assert.deepEqual(composed.packages[0].origin, { layer: "base", identity: "git:base@sha#preset.json" });
  // A supplied include replaces the candidate set; nothing was excluded, so
  // both remain loaded.
  assert.deepEqual(selectorsOf(composed).loaded, ["skills/b/SKILL.md"]);
  assert.deepEqual(
    composed.persona.append.map((entry) => `${entry.layer}:${entry.text}`),
    ["base:from the base", "preset:from the preset"]
  );
});

test("an omitted include inherits, an empty include chooses none", () => {
  const inherited = compose([
    baseLayer({
      packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
      resources: [{ package: "tools", kind: "skills", include: ["skills/a/SKILL.md"] }],
    }),
    presetLayer({
      resources: [{ package: "tools", kind: "skills", exclude: ["skills/z/SKILL.md"] }],
    }),
  ]);
  assert.deepEqual(selectorsOf(inherited).loaded, ["skills/a/SKILL.md"]);

  const none = compose([
    baseLayer({
      packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
      resources: [{ package: "tools", kind: "skills", include: ["skills/a/SKILL.md"] }],
    }),
    presetLayer({ resources: [{ package: "tools", kind: "skills", include: [] }] }),
  ]);
  assert.deepEqual(selectorsOf(none).include, []);
  assert.deepEqual(selectorsOf(none).loaded, [], "an empty include still loaded something");
});

test("a lower exclusion persists until a higher layer re-includes the path", () => {
  const composed = compose([
    baseLayer({
      packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
      resources: [
        { package: "tools", kind: "skills", include: ["skills/a/SKILL.md"], exclude: ["skills/b/SKILL.md"] },
      ],
    }),
    presetLayer({ resources: [{ package: "tools", kind: "skills", include: ["skills/b/SKILL.md"] }] }),
  ]);

  const selector = selectorsOf(composed);
  assert.deepEqual(selector.loaded, ["skills/b/SKILL.md"], "the re-include did not take effect");
  assert.deepEqual(selector.exclude, [], "the re-included path stayed excluded");
});

test("same-layer exclusion wins over same-layer inclusion", () => {
  const composed = compose([
    presetLayer({
      packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
      resources: [
        {
          package: "tools",
          kind: "skills",
          include: ["skills/a/SKILL.md", "skills/b/SKILL.md"],
          exclude: ["skills/a/SKILL.md"],
        },
      ],
    }),
  ]);

  const selector = selectorsOf(composed);
  assert.deepEqual(selector.loaded, ["skills/b/SKILL.md"]);
  assert.deepEqual(
    selector.excluded.map((entry) => entry.path),
    ["skills/a/SKILL.md"]
  );
});

test("a selector without a kind keeps its identity, an absent selector loads none", () => {
  const composed = compose([
    presetLayer({
      packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
      resources: [{ package: "tools", include: ["skills/a/SKILL.md"] }],
    }),
  ]);
  assert.deepEqual(
    composed.resources.map((selector) => `${selector.package}:${selector.kind}:${selector.generic}`),
    ["tools:resources:true"]
  );
  assert.deepEqual(executableIdentity(composed).resources, ["tools:resources:skills/a/SKILL.md"]);

  const silent = compose([presetLayer({ packages: { tools: { source: "npm:@scope/tools@1.0.0" } } })]);
  assert.deepEqual(executableIdentity(silent).resources, [], "a package with no selector loaded something");
});

test("tools fold by layer: same-layer disable wins, a higher layer may re-enable", () => {
  const composed = compose([
    baseLayer({ runtime: { tools: { enable: ["bash", "web"] } } }, "base"),
    layer("preset", "preset", declaration({ runtime: { tools: { enable: ["bash"], disable: ["bash"] } } })),
  ]);
  const tools = composed.runtime.tools;
  assert.deepEqual(
    tools.enabled.map((entry) => entry.tool),
    ["web"],
    "the same layer's exclusion did not win"
  );
  assert.deepEqual(
    tools.disabled.map((entry) => entry.tool),
    ["bash"]
  );

  const session = layer("session", "session-overlay.json", {
    runtime: { tools: { enable: ["bash"] } },
  });
  const reEnabled = compose([
    baseLayer({ runtime: { tools: { disable: ["bash"] } } }, "base"),
    session,
  ]).runtime.tools;
  assert.deepEqual(
    reEnabled.enabled.map((entry) => `${entry.tool}:${entry.layer}`),
    ["bash:session"]
  );
  assert.deepEqual(reEnabled.disabled, []);
});

test("a CLI exclusion survives every layer and the refusal keeps its reason", () => {
  const composed = compose(
    [
      baseLayer({ runtime: { tools: { enable: ["bash"] } } }, "base"),
      layer("preset", "preset", declaration({ runtime: { tools: { enable: ["bash", "web"] } } })),
    ],
    { restrictions: { disabledTools: ["bash"] } }
  );
  const tools = composed.runtime.tools;
  assert.deepEqual(
    tools.enabled.map((entry) => entry.tool),
    ["web"]
  );
  assert.deepEqual(
    tools.disabled.map((entry) => entry.tool),
    ["bash"]
  );
  assert.match(tools.disabled[0].reason, /user or CLI excluded/);
  assert.deepEqual(
    tools.unmet.map((entry) => entry.tool),
    ["bash", "bash"],
    "both layers' requests for an excluded tool were not reported"
  );
  assert.match(tools.unmet[0].reason, /cannot re-enable/);

  // A tool that is both excluded and disabled by a layer is reported once, with
  // the reason it is unavailable.
  const both = compose(
    [layer("preset", "preset", declaration({ runtime: { tools: { disable: ["bash"] } } }))],
    { restrictions: { disabledTools: ["bash"] } }
  ).runtime.tools;
  assert.deepEqual(
    both.disabled.map((entry) => entry.tool),
    ["bash"]
  );
  assert.match(both.disabled[0].reason, /user or CLI excluded/);
});

test("an explicit model choice beats a declared preference, thinking takes the highest layer", () => {
  const layers = [
    baseLayer({ runtime: { model: { provider: "base", id: "small" }, thinking: "low" } }, "base"),
    layer("preset", "preset", declaration({ runtime: { model: { provider: "preset", id: "large" }, thinking: "high" } })),
  ];
  const chosen = compose(layers, { restrictions: { model: "cli/chosen" } });
  assert.equal(chosen.runtime.model.winner, "user");
  assert.equal(chosen.runtime.model.value, "cli/chosen");
  assert.match(chosen.runtime.model.reason, /explicit user or CLI model choice wins/);
  assert.deepEqual(
    chosen.runtime.model.declared.map((entry) => entry.value),
    ["base/small", "preset/large"]
  );

  const declared = compose(layers);
  assert.equal(declared.runtime.model.winner, "preset");
  assert.equal(declared.runtime.thinking.value, "high");
  assert.equal(declared.runtime.thinking.layer, "preset");
});

test("instructions append in layer order and never replace each other", () => {
  const composed = compose([
    baseLayer({ persona: { append: ["one", "two"] } }, "base"),
    layer("user", "user.json", { persona: { append: ["three"] } }),
    layer("session", "session.json", { persona: { append: ["four"] } }),
  ]);
  assert.deepEqual(
    composed.persona.append.map((entry) => entry.text),
    ["one", "two", "three", "four"]
  );
  assert.deepEqual(
    composed.persona.append.map((entry) => entry.layer),
    ["base", "base", "user", "session"]
  );
});

test("only an executable change requires a new reviewed revision", () => {
  const layers = [
    presetLayer({
      packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
      resources: [{ package: "tools", kind: "skills", include: ["skills/a/SKILL.md"] }],
      runtime: { thinking: "low" },
    }),
  ];
  const before = compose(layers);
  const soft = classifyChange(
    before,
    compose([...layers, layer("session", "session.json", { runtime: { thinking: "high" } })])
  );
  assert.equal(soft.requiresNewRevision, false);
  assert.deepEqual(soft.soft, ["thinking"]);

  const changed = presetLayer(
    {
      packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
      resources: [{ package: "tools", kind: "skills", include: ["skills/b/SKILL.md"] }],
      runtime: { thinking: "low" },
    },
    "local#preset"
  );
  const executable = classifyChange(before, compose([changed]));
  assert.equal(executable.requiresNewRevision, true);
  assert.deepEqual(executable.executable, [
    "+ tools:skills:skills/b/SKILL.md",
    "- tools:skills:skills/a/SKILL.md",
  ]);
});

test("an alias cannot be rebound and two versions of one package cannot both be required", () => {
  const rebound = () =>
    compose([
      baseLayer({ packages: { tools: { source: "npm:@scope/tools@1.0.0" } } }, "git:base@sha#preset.json"),
      layer("preset", "git:child@sha#preset.json", declaration({ packages: { tools: { source: "npm:@scope/other@1.0.0" } } })),
    ]);
  assert.throws(rebound, (error) => {
    assert.match(error.message, /rebound to another package/);
    const text = error.format();
    assert.match(text, /git:base@sha#preset\.json/);
    assert.match(text, /git:child@sha#preset\.json/);
    return true;
  });

  const conflicting = () =>
    compose([
      baseLayer({ packages: { old: { source: "npm:@scope/tools@1.0.0" } } }, "git:base@sha#preset.json"),
      layer("preset", "git:child@sha#preset.json", declaration({ packages: { fresh: { source: "npm:@scope/tools@3.0.0" } } })),
    ]);
  assert.throws(conflicting, (error) => {
    const text = error.format();
    assert.match(text, /npm:@scope\/tools is required at two versions/);
    assert.match(text, /git:base@sha#preset\.json/);
    assert.match(text, /git:child@sha#preset\.json/);
    return true;
  });

  // Restating the same alias at the same version is inheritance, not a conflict.
  const restated = compose([
    baseLayer({ packages: { tools: { source: "npm:@scope/tools@1.0.0" } } }, "base"),
    layer("preset", "preset", declaration({ packages: { tools: { source: "npm:@scope/tools@1.0.0" } } })),
  ]);
  assert.equal(restated.packages.length, 1);
});

test("a preset inherits from a reviewed parent source and the plan names both revisions", async () => {
  const h = harness();
  await installManager(h);
  const parent = await repo(h, "comp-parent", [
    {
      message: "parent",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({
            id: "base-preset",
            name: "Base",
            packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
            resources: [
              {
                package: "tools",
                kind: "skills",
                include: ["skills/review/SKILL.md", "skills/legacy/SKILL.md"],
                exclude: ["skills/legacy/SKILL.md"],
              },
            ],
            persona: { append: ["base instruction"] },
          })
        )}\n`,
      },
    },
  ]);
  const child = await repo(h, "comp-child", [
    {
      message: "child",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({
            id: "composed",
            extends: { source: parent.sourceAt(parent.commits[0]) },
            persona: { append: ["child instruction"] },
          })
        )}\n`,
      },
    },
  ]);

  const result = await wardrobe(h, `install ${child.sourceAt(child.commits[0])}`);

  assert.equal(result.ok, true, result.text);
  assert.deepEqual(
    result.plan.layers.map((entry) => entry.kind),
    ["base", "preset"]
  );
  assert.equal(result.plan.layers[0].source.commit, parent.commits[0]);
  assert.equal(result.plan.layers[1].source.commit, child.commits[0]);
  const surface = result.plan.installationSurfaces.find((entry) => entry.alias === "tools");
  assert.equal(surface.declaredBy.layer, "base", "the inherited package lost its origin");
  assert.ok(surface.artifact.integrity, "the inherited package was not resolved to an artifact");
  // The base excluded one path; the higher layer must not silently load it.
  const selector = result.plan.resourceSelectors.find(
    (entry) => entry.package === "tools" && entry.kind === "skills"
  );
  assert.deepEqual(selector.loaded, ["skills/review/SKILL.md"]);
  assert.deepEqual(
    selector.excluded.map((entry) => entry.path),
    ["skills/legacy/SKILL.md"]
  );
  assert.match(selector.excluded[0].identity, /comp-parent/);
  assert.deepEqual(
    result.plan.loadSurfaces.map((entry) => entry.surface),
    ["skills:tools/skills/review/SKILL.md"]
  );
  assert.deepEqual(
    result.plan.persona.append.map((entry) => entry.layer),
    ["base", "preset"]
  );
  assert.match(
    result.text,
    new RegExp(`base: git:${h.server.origin}/git/comp-parent\\.git@${parent.commits[0]}`),
    `the plan text did not name the parent's pinned revision:\n${result.text}`
  );
  h.record("inherited-parent-is-reviewed-at-its-own-commit", {
    layers: result.plan.layers.map((entry) => `${entry.kind}@${entry.source.commit}`),
    installedBy: surface.declaredBy.layer,
    loaded: selector.loaded,
    excluded: selector.excluded,
  });
});

test("an inheritance cycle is refused with the whole chain", async () => {
  // A cycle cannot be produced by honest pinned SHAs — each commit would have
  // to contain its own SHA — so it is guarded directly: whichever way a cycle
  // is reached, there is no first layer to resolve.
  const node = (locator, extendsTo) => ({
    kind: "git",
    locator,
    commit: "0".repeat(40),
    root: "/nonexistent",
    treeDigest: "digest",
    presets: [
      {
        path: "preset.json",
        digest: "digest",
        source: locator,
        definition: declaration({ extends: extendsTo ? { source: extendsTo } : undefined }),
      },
    ],
  });
  const capture = async (locator) => node(locator, locator === "git:a@sha" ? "git:b@sha" : "git:a@sha");

  const start = node("git:a@sha", "git:b@sha");
  await assert.rejects(
    () => resolveChain({ captured: start, preset: start.presets[0], capture }),
    (error) => {
      assert.match(error.message, /forms a cycle/);
      const text = error.format();
      for (const entry of ["git:a@sha", "git:b@sha"]) {
        assert.ok(text.includes(entry), `the refusal did not name ${entry}: ${text}`);
      }
      return true;
    }
  );

  // A parent that declares more than one preset is refused rather than guessed.
  const ambiguous = node("git:multi@sha", "git:two@sha");
  ambiguous.presets.push({ ...ambiguous.presets[0], path: "presets/other/preset.json" });
  await assert.rejects(
    () => resolveChain({ captured: ambiguous, preset: ambiguous.presets[0], capture: async () => ambiguous }),
    /more than one preset/
  );
});

test("an omitted include inherits through real validation and a re-included path keeps its new origin", async () => {
  const h = harness();
  await installManager(h);
  // Both declarations are written to disk and validated: "an omitted include
  // inherits" is a rule about real declarations, not about folded objects.
  const parent = await repo(h, "comp-inherit", [
    {
      message: "parent",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({
            id: "base-preset",
            name: "Base",
            packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } },
            resources: [
              {
                package: "tools",
                kind: "skills",
                include: ["skills/keep/SKILL.md", "skills/drop/SKILL.md"],
                exclude: ["skills/drop/SKILL.md"],
              },
            ],
          })
        )}\n`,
      },
    },
  ]);
  const child = await repo(h, "comp-reinclude", [
    {
      message: "child",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({
            id: "composed",
            extends: { source: parent.sourceAt(parent.commits[0]) },
            // No include: the parent's selection is inherited, minus one path.
            resources: [{ package: "tools", kind: "skills", exclude: ["skills/keep/SKILL.md"] }],
          })
        )}\n`,
      },
    },
  ]);

  const result = await wardrobe(h, `install ${child.sourceAt(child.commits[0])}`);
  assert.equal(result.ok, true, result.text);
  const selector = result.plan.resourceSelectors.find(
    (entry) => entry.package === "tools" && entry.kind === "skills"
  );
  assert.deepEqual(selector.loaded, [], "an inherited include was not filtered by the child");
  assert.deepEqual(
    selector.excluded.map((entry) => `${entry.path}@${entry.layer}`),
    ["skills/drop/SKILL.md@base", "skills/keep/SKILL.md@preset"]
  );
  assert.deepEqual(result.plan.loadSurfaces, []);

  // A path re-included by a higher layer is attributed to that layer, not to
  // the selector that first named it.
  const reincluded = await repo(h, "comp-reincluded", [
    {
      message: "child",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({
            id: "composed",
            extends: { source: parent.sourceAt(parent.commits[0]) },
            resources: [{ package: "tools", kind: "skills", include: ["skills/drop/SKILL.md"] }],
          })
        )}\n`,
      },
    },
  ]);
  const explained = await wardrobe(
    h,
    `install ${reincluded.sourceAt(reincluded.commits[0])}`
  );
  assert.equal(explained.ok, true, explained.text);
  const folded = explained.plan.resourceSelectors.find(
    (entry) => entry.package === "tools" && entry.kind === "skills"
  );
  assert.deepEqual(folded.loaded, ["skills/drop/SKILL.md"]);
  const origin = folded.declaredBy.findLast((entry) => entry.path === "skills/drop/SKILL.md");
  assert.equal(origin.action, "re-include");
  assert.match(origin.identity, /comp-reincluded/, "a re-included path kept the base's identity");
  h.record("inherited-selectors-keep-their-origin", {
    inheritedAndExcluded: selector.excluded.map((entry) => `${entry.path}@${entry.layer}`),
    reIncludedBy: origin.layer,
  });
});

test("an overlay is reported as a soft change that keeps the reviewed revision", async () => {
  const h = harness();
  await installManager(h);
  const source = `${h.sandbox.root}/preset-sources/revision`;
  mkdirSync(join(source, "solo"), { recursive: true });
  writeFileSync(
    join(source, "solo", "preset.json"),
    `${JSON.stringify(
      declaration({
        id: "solo",
        packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
        resources: [{ package: "tools", kind: "skills", include: ["skills/a/SKILL.md"] }],
        runtime: { thinking: "low" },
      })
    )}\n`
  );
  const overlay = join(h.sandbox.root, "soft-overlay.json");
  writeFileSync(
    overlay,
    `${JSON.stringify({ runtime: { thinking: "high" }, persona: { append: ["overlay"] } })}\n`
  );

  const result = await wardrobe(h, `explain solo --overlay ${overlay}`, {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });

  assert.equal(result.ok, true, result.text);
  assert.deepEqual(result.revision.executable, []);
  assert.equal(result.revision.requiresNewRevision, false);
  assert.deepEqual(result.revision.soft, ["persona", "thinking"]);
  assert.deepEqual(result.layers.map((entry) => entry.kind), ["preset", "session"]);
  assert.match(result.text, /overlay change: soft only/);
  h.record("overlay-keeps-the-reviewed-revision", {
    soft: result.revision.soft,
    requiresNewRevision: result.revision.requiresNewRevision,
  });
});

test("explain traces composed values to their layer and never exposes secrets", async () => {
  const h = harness();
  await installManager(h);
  const source = `${h.sandbox.root}/preset-sources/composed`;
  mkdirSync(join(source, "composed"), { recursive: true });
  writeFileSync(
    join(source, "composed", "preset.json"),
    `${JSON.stringify(
      declaration({
        packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
        resources: [
          {
            package: "tools",
            kind: "skills",
            include: ["skills/a/SKILL.md", "skills/b/SKILL.md"],
            exclude: ["skills/b/SKILL.md"],
          },
        ],
        runtime: { thinking: "high", tools: { enable: ["bash", "secret_tool"] }, model: { provider: "p", id: "m" } },
        persona: { append: ["be careful"] },
      })
    )}\n`
  );
  // The agent directory holds a credential store; an explain result is built
  // from reviewed declarations and must never carry its contents.
  const secret = "never-read-by-fixtures";

  const result = await wardrobe(h, "explain composed --disable-tool secret_tool --model cli/chosen", {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });

  assert.equal(result.ok, true, result.text);
  const byPath = Object.fromEntries(result.fields.map((entry) => [entry.path, entry]));
  assert.equal(byPath["/runtime/thinking"].value, "high");
  assert.match(byPath["/runtime/thinking"].origin, /preset layer/);
  assert.equal(byPath["/runtime/model"].value, "cli/chosen", "an explicit model choice did not win");
  assert.match(byPath["/runtime/model"].reason, /user or CLI/);
  const disabled = result.disabled.find((entry) => entry.tool === "secret_tool");
  assert.match(disabled.reason, /user or CLI excluded/);
  assert.deepEqual(
    result.unmet.map((entry) => entry.tool),
    ["secret_tool"]
  );
  const excluded = result.resources.flatMap((selector) => selector.excluded);
  assert.deepEqual(
    excluded.map((entry) => entry.path),
    ["skills/b/SKILL.md"]
  );
  assert.match(excluded[0].reason, /preset layer excluded it/);
  assert.deepEqual(
    result.executable.resources,
    ["tools:skills:skills/a/SKILL.md"]
  );
  const rendered = JSON.stringify(result);
  assert.ok(!rendered.includes(secret), "a secret from the agent directory reached the result");
  h.record("explain-traces-layers-without-secrets", {
    layers: result.layers.map((entry) => entry.kind),
    disabled: result.disabled.map((entry) => `${entry.tool}:${entry.reason}`),
    excluded: excluded.map((entry) => entry.path),
    secretsRendered: false,
  });
});

test("a user overlay changes preferences and a session overlay may not add executable code", async () => {
  const h = harness();
  await installManager(h);
  const source = `${h.sandbox.root}/preset-sources/overlay`;
  mkdirSync(join(source, "solo"), { recursive: true });
  writeFileSync(
    join(source, "solo", "preset.json"),
    `${JSON.stringify(
      declaration({
        id: "solo",
        runtime: { thinking: "low" },
        packages: { tools: { source: "npm:@scope/tools@1.0.0" } },
        persona: { append: ["preset instruction"] },
      })
    )}\n`
  );
  mkdirSync(join(h.agentPath("primary"), "wardrobe"), { recursive: true });
  writeFileSync(
    join(h.agentPath("primary"), "wardrobe", "user.json"),
    `${JSON.stringify({ runtime: { thinking: "high" }, persona: { append: ["user instruction"] } })}\n`
  );

  const overlaid = await wardrobe(h, "explain solo", { extraEnv: { WARDROBE_PRESET_DIRS: source } });
  assert.equal(overlaid.ok, true, overlaid.text);
  const thinking = overlaid.fields.find((entry) => entry.path === "/runtime/thinking");
  assert.equal(thinking.value, "high");
  assert.match(thinking.origin, /user layer/, `the user layer did not win: ${thinking.origin}`);
  assert.deepEqual(
    overlaid.persona.append.map((entry) => entry.layer),
    ["preset", "user"]
  );
  assert.deepEqual(
    overlaid.executable.resources,
    [],
    "a package with no selector loaded something"
  );

  const executableOverlay = join(h.sandbox.root, "overlay-with-code.json");
  writeFileSync(
    executableOverlay,
    `${JSON.stringify({ packages: { extra: { source: "npm:@scope/extra@1.0.0" } } })}\n`
  );
  const refused = await wardrobe(h, `explain solo --overlay ${executableOverlay}`, {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });
  assert.equal(refused.ok, false, "an overlay that adds a package was accepted");
  assert.match(refused.text, /is not a valid overlay/);
  assert.match(refused.text, /\/packages: an overlay may not declare "packages"/);
  assert.match(refused.text, /review a new preset instead/);

  const resourceOverlay = join(h.sandbox.root, "overlay-with-resources.json");
  writeFileSync(
    resourceOverlay,
    `${JSON.stringify({ resources: [{ package: "tools", include: ["skills/a/SKILL.md"] }] })}\n`
  );
  const resourceRefused = await wardrobe(h, `explain solo --overlay ${resourceOverlay}`, {
    extraEnv: { WARDROBE_PRESET_DIRS: source },
  });
  assert.equal(resourceRefused.ok, false, "an overlay that adds a resource was accepted");
  assert.match(resourceRefused.text, /\/resources/);
  h.record("overlays-are-soft-only", {
    userThinking: thinking.value,
    userOrigin: thinking.origin,
    executableOverlay: refused.text.split("\n")[0],
    resourceOverlay: resourceRefused.text.split("\n")[0],
  });
});

test("a plan names no load surface when no effective selector selects one", async () => {
  const h = harness();
  await installManager(h);
  const git = await repo(h, "comp-silent", [
    {
      message: "add",
      files: {
        "preset.json": `${JSON.stringify(
          declaration({ packages: { tools: { source: "npm:wardrobe-fixture@1.0.0" } } })
        )}\n`,
      },
    },
  ]);

  const result = await wardrobe(h, `install ${git.sourceAt(git.commits[0])}`);

  assert.equal(result.ok, true, result.text);
  assert.deepEqual(result.plan.loadSurfaces, []);
  assert.deepEqual(result.plan.executable.resources, []);
  assert.match(result.text, /nothing: no effective selector selects a resource/);
  h.record("absent-selectors-load-none", {
    packages: result.plan.installationSurfaces.length,
    loadSurfaces: result.plan.loadSurfaces.length,
  });
});

test("a self resource inherited from a parent is checked against the parent's capture", () => {
  // The path a self source names lives in the package that ships the
  // declaration, so folding must not lose which capture declared it.
  const composed = compose([
    layer(
      "base",
      "git:parent@sha#preset.json",
      declaration({
        packages: { itself: { source: "." } },
        resources: [{ package: "itself", kind: "skills", include: ["skills/a/SKILL.md"] }],
      }),
      { kind: "git", url: "file:///parent.git", commit: "a".repeat(40), locator: "git:file:///parent.git" }
    ),
  ]);
  assert.deepEqual(
    composed.packages.map((entry) => `${entry.alias}:${entry.canonical}`),
    ["itself:git:file:///parent.git"]
  );
  const selector = foldResources(
    [
      layer("base", "git:parent@sha#preset.json", {
        packages: { itself: { source: "." } },
        resources: [{ package: "itself", kind: "skills", include: ["skills/a/SKILL.md"] }],
      }),
    ],
    [{ alias: "itself" }]
  ).find((entry) => entry.kind === "skills");
  assert.deepEqual(selector.contributions, [
    {
      layer: "base",
      identity: "git:parent@sha#preset.json",
      path: "/resources/0",
      include: ["skills/a/SKILL.md"],
    },
  ]);
});
