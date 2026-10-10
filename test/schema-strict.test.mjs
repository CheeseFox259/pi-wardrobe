// Strict preset-declaration validation.
//
// A preset is authored by strangers, so an unknown or excluded field is refused
// with the exact path that caused it rather than silently defaulted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource } from "../packages/wardrobe/src/identity.mjs";
import { validateDefinition } from "../packages/wardrobe/src/schema.mjs";
import { composedPreset, minimalCoding } from "./support/presets.mjs";

function reject(definition) {
  const result = validateDefinition(definition);
  assert.equal(result.ok, false, `expected a rejection for ${JSON.stringify(definition)}`);
  return result.error.format();
}

function paths(definition) {
  const result = validateDefinition(definition);
  assert.equal(result.ok, false, "expected a rejection");
  return result.error.diagnostics.map((diagnostic) => diagnostic.path);
}

test("a self-contained Minimal Coding declaration is accepted", () => {
  const result = validateDefinition(minimalCoding());
  assert.equal(result.ok, true);
  assert.equal(result.definition.id, "minimal-coding");
});

test("a declaration with packages, resources and preferences is accepted", () => {
  const result = validateDefinition(composedPreset());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.definition.packages), ["@scope/tools"]);
});

test("unknown fields are refused with their exact path", () => {
  assert.deepEqual(paths({ ...minimalCoding(), mysteryField: 1 }), ["/mysteryField"]);
  assert.deepEqual(paths({ ...minimalCoding(), runtime: { nope: true } }), [
    "/runtime/nope",
  ]);
  assert.deepEqual(
    paths({ ...minimalCoding(), compatibility: { pi: "*", extra: 1 } }),
    ["/compatibility/extra"]
  );
});

test("credential fields are refused with the reason they are excluded", () => {
  const message = reject({ ...minimalCoding(), credentials: { apiKey: "sk-1" } });
  assert.match(message, /\/credentials/);
  assert.match(message, /cannot declare credentials/);
  assert.match(reject({ ...minimalCoding(), apiKey: "sk-1" }), /cannot declare credentials/);
});

test("MCP server definitions are refused as out of scope", () => {
  const message = reject({
    ...minimalCoding(),
    mcpServers: { docs: { command: "docs-server" } },
  });
  assert.match(message, /\/mcpServers/);
  assert.match(message, /out of scope/);
});

test("script hooks are refused and redirected to packages", () => {
  const message = reject({ ...minimalCoding(), postinstall: "node setup.mjs" });
  assert.match(message, /\/postinstall/);
  assert.match(message, /script hooks are not part of the preset contract/);
});

test("plugin-private configuration is refused", () => {
  assert.match(
    reject({ ...minimalCoding(), packages: { tools: { source: "npm:a@1.0.0", private: {} } } }),
    /\/packages\/tools\/private/
  );
});

test("malformed metadata is refused with an actionable hint", () => {
  assert.match(reject({ ...minimalCoding(), version: "latest" }), /\/version/);
  assert.match(reject({ ...minimalCoding(), version: "latest" }), /exact version/);
  assert.match(
    reject({ ...minimalCoding(), compatibility: { pi: "1.1" } }),
    /\/compatibility\/pi/
  );
  assert.match(reject({ ...minimalCoding(), schemaVersion: 2 }), /\/schemaVersion/);
  assert.match(reject({ ...minimalCoding(), id: "Not A Slug" }), /\/id/);
  assert.deepEqual(paths({ ...minimalCoding(), name: "" }), ["/name"]);
});

test("missing required fields are all reported, not just the first", () => {
  const result = validateDefinition({ schemaVersion: 1 });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.error.diagnostics.map((diagnostic) => diagnostic.path).sort(),
    ["/compatibility", "/id", "/name", "/version"]
  );
});

test("package sources must be qualified and pinned", () => {
  assert.match(
    reject({ ...composedPreset(), packages: { t: { source: "./local" } } }),
    /\/packages\/t\/source/
  );
  assert.match(
    reject({ ...composedPreset(), packages: { t: { source: "npm:@scope/tools" } } }),
    /npm:<name>@<exact-version>/
  );
  assert.match(
    reject({ ...composedPreset(), packages: { t: { source: "npm:@scope/tools@^1.0.0" } } }),
    /not an exact version/
  );
});

test("a git source must pin a full commit SHA", () => {
  const pinned = composedPreset({
    packages: { t: { source: `git:https://example.invalid/r.git@${"a".repeat(40)}` } },
    resources: [],
  });
  assert.equal(validateDefinition(pinned).ok, true);
  assert.deepEqual(parseSource("git:https://example.invalid/r.git@" + "a".repeat(40)).exact, true);
  assert.match(
    reject(composedPreset({ packages: { t: { source: "git:https://example.invalid/r.git@main" } } })),
    /not a full 40-character commit SHA/
  );
  assert.match(
    reject(composedPreset({ packages: { t: { source: "git:https://example.invalid/r.git" } } })),
    /no commit was pinned/
  );
});

test("resource selectors require package-relative paths", () => {
  const selector = (include) =>
    composedPreset({ resources: [{ package: "@scope/tools", kind: "skills", include }] });
  assert.equal(validateDefinition(selector(["skills/a/SKILL.md"])).ok, true);
  // An explicitly empty optional exclude is allowed; an empty include is not.
  assert.equal(
    validateDefinition(
      composedPreset({
        resources: [
          { package: "@scope/tools", kind: "skills", include: ["skills/a/SKILL.md"], exclude: [] },
        ],
      })
    ).ok,
    true
  );
  assert.match(
    reject(composedPreset({ resources: [{ package: "toString", include: ["a"] }] })),
    /not declared in \/packages/
  );
  assert.match(reject(selector([])), /\/resources\/0\/include/);
  assert.match(reject(selector(["/etc/passwd"])), /package-relative path/);
  assert.match(reject(selector(["../../secrets"])), /package-relative path/);
  assert.match(
    reject(composedPreset({ resources: [{ package: "@scope/tools" }] })),
    /\/resources\/0\/include/
  );
});

test("a namespaced preset id from the reference definitions is accepted", () => {
  const result = validateDefinition(minimalCoding({ id: "wardrobe/minimal-coding" }));
  assert.equal(result.ok, true);
  assert.equal(result.definition.id, "wardrobe/minimal-coding");
});

test("a package may declare itself with the source '.'", () => {
  const result = validateDefinition(
    composedPreset({ packages: { self: { source: "." } }, resources: [] })
  );
  assert.equal(result.ok, true);
  assert.deepEqual(parseSource("."), { kind: "self", exact: true });
});

test("every documented resource kind is accepted", () => {
  const result = validateDefinition(
    composedPreset({
      resources: [
        { package: "@scope/tools", kind: "extensions", include: ["ext/a.mjs"] },
        { package: "@scope/tools", kind: "skills", include: ["skills/a/SKILL.md"] },
        { package: "@scope/tools", kind: "prompts", include: ["prompts/a.md"] },
        { package: "@scope/tools", kind: "themes", include: ["themes/a.json"] },
      ],
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.definition.resources.length, 4);
  assert.match(
    reject(
      composedPreset({
        resources: [{ package: "@scope/tools", kind: "agents", include: ["a"] }],
      })
    ),
    /\/resources\/0\/kind/
  );
});

test("a non-object declaration is refused rather than coerced", () => {
  assert.match(reject([]), /expected an object/);
  assert.match(reject(null), /expected an object/);
});
