// Parent chain resolution.
//
// A preset may inherit from exactly one reviewed parent. The parent is
// captured from its own pinned source — a full commit for Git, an exact
// version for npm — so inheritance never introduces an unreviewed artifact and
// never reuses whatever happens to be on disk.
//
// Cycles are refused with the whole chain, because "which of these two
// declarations wins" is not a question a merge can answer.

import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";

/**
 * Resolve `captured`/`preset` and its ancestors into ordered layers.
 *
 * @param {{captured: object, preset: object, capture: (locator: string) => Promise<object>}} input
 *   `capture` returns a captured source; the same capture path the top-level
 *   source went through, so a parent is read exactly as carefully.
 * @returns {Promise<object[]>} layers ordered base first, the preset itself last
 */
export async function resolveChain({ captured, preset, capture, chain = [] }) {
  const key = identityOf(captured, preset);
  if (chain.includes(key)) {
    throw WardrobeError.from("preset inheritance forms a cycle", [
      ...chain.map((entry) => new WardrobeDiagnostic({ path: "", reason: `inherits ${entry}` })),
      new WardrobeDiagnostic({ path: "", reason: `repeats ${key}` }),
    ], "no layer can be resolved first; break the cycle in the declarations");
  }

  const seen = [...chain, key];
  const definition = preset.definition;
  const parent = definition.extends;
  if (!parent) {
    return [
      {
        kind: "preset",
        identity: key,
        captured,
        preset,
        definition,
      },
    ];
  }

  const locator = parent.presetPath ? `${parent.source}#${parent.presetPath}` : parent.source;
  const parentCapture = await capture(locator);
  const parentPreset = selectParent(parentCapture, parent.presetPath, locator);
  const inherited = await resolveChain({
    captured: parentCapture,
    preset: parentPreset,
    capture,
    chain: seen,
  });

  return [
    ...inherited.map((layer) => ({ ...layer, kind: "base" })),
    { kind: "preset", identity: key, captured, preset, definition },
  ];
}

/**
 * Choose the declaration a parent reference names.
 *
 * A reference without a path is only unambiguous when the parent source
 * declares exactly one preset; otherwise the user chooses, as with any
 * multi-preset source.
 */
function selectParent(captured, presetPath, locator) {
  if (captured.presets.length === 0) {
    throw WardrobeError.from("parent source declares no presets", [
      new WardrobeDiagnostic({ path: "/extends/source", reason: `${locator} contains no valid preset.json` }),
    ]);
  }
  if (presetPath) {
    const match = captured.presets.find((entry) => entry.path === presetPath);
    if (!match) {
      throw WardrobeError.from("parent preset path not found", [
        new WardrobeDiagnostic({
          path: "/extends/presetPath",
          reason: `${JSON.stringify(presetPath)} is not declared by ${locator}`,
        }),
        new WardrobeDiagnostic({
          path: "",
          reason: `candidates: ${captured.presets.map((entry) => entry.path).join(", ")}`,
        }),
      ]);
    }
    return match;
  }
  if (captured.presets.length > 1) {
    throw WardrobeError.from("parent source declares more than one preset", [
      ...captured.presets.map(
        (entry) =>
          new WardrobeDiagnostic({
            path: "/extends",
            reason: `candidate: ${entry.path} (${entry.definition.name})`,
          })
      ),
    ], `declare which parent to inherit, e.g. ${locator}#${captured.presets[0].path}`);
  }
  return captured.presets[0];
}

function identityOf(captured, preset) {
  return `${captured.locator}#${preset.path}`;
}
