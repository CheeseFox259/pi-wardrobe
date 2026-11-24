// Composition: Base -> Preset -> User -> Session.
//
// A declaration is never the whole environment. One reviewed parent may be
// inherited, and a user or session overlay may add preferences on top. Every
// effective value produced here keeps the layer it came from, so `explain`
// reports provenance instead of an opaque merge.
//
// Two rules are load-bearing and deliberately not generic deep merge:
//   - Aliases are stable. An inherited alias cannot be rebound to another
//     canonical package, and two layers may not require different versions of
//     one canonical package.
//   - Overlays are soft. User and session layers may change tools, thinking,
//     and appended instructions, and nothing else. Executable identity
//     belongs to a reviewed revision, so a change to it needs a new one.

import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { parseSource } from "./identity.mjs";

/** A selector without a `kind` applies to the package as a whole. */
const GENERIC_KIND = "resources";

/**
 * Compose ordered layers into one described environment.
 *
 * @param {object[]} layers ordered base-first; each carries `kind`, `identity`,
 *   `captured` and `definition`
 * @param {{restrictions?: object}} options `restrictions` describes choices a
 *   preset may never override: CLI exclusions and the user's authorization
 *   boundary.
 * @returns {object} plain data: every value is JSON-serialisable and carries
 *   the layer that produced it
 */
export function compose(layers, { restrictions = {} } = {}) {
  const packages = foldPackages(layers);
  return {
    layers: layers.map(describeLayer),
    packages,
    resources: foldResources(layers, packages),
    runtime: {
      tools: foldTools(layers, restrictions),
      thinking: foldThinking(layers),
    },
    persona: foldPersona(layers),
  };
}

/** The public identity of a layer, without its captured content. */
export function describeLayer(layer) {
  const captured = layer.captured ?? {};
  return {
    kind: layer.kind,
    identity: layer.identity,
    source: {
      kind: captured.kind ?? null,
      locator: captured.locator ?? null,
      commit: captured.commit ?? null,
      version: captured.version ?? null,
      integrity: captured.integrity ?? null,
      treeDigest: captured.treeDigest ?? null,
    },
    declarationPath: layer.preset?.path ?? null,
    declarationDigest: layer.preset?.digest ?? null,
  };
}

/**
 * Canonical identity of a declared package source.
 *
 * Derived from the declaration alone so composition never has to resolve an
 * artifact to decide whether two layers agree. `self` borrows the identity of
 * the capture the declaration shipped in.
 */
export function canonicalOf(source, captured) {
  const parsed = parseSource(source);
  if (parsed.kind === "npm") return { canonical: `npm:${parsed.package}`, version: parsed.version };
  if (parsed.kind === "git") return { canonical: `git:${parsed.url}`, version: parsed.ref };
  if (captured?.kind === "npm") {
    return { canonical: `npm:${captured.name ?? captured.locator}`, version: captured.version };
  }
  if (captured?.url) return { canonical: `git:${captured.url}`, version: captured.commit ?? null };
  throw WardrobeError.from("self source has no pinned native source", [
    new WardrobeDiagnostic({
      path: "/packages",
      reason: "the declaration this source belongs to was not captured from npm or git",
      hint: "a self source is the package that ships the declaration; review that package directly",
    }),
  ]);
}

/** Fold `packages` across layers, refusing rebinding and version conflicts. */
export function foldPackages(layers) {
  const byAlias = new Map();
  const byCanonical = new Map();
  for (const layer of layers) {
    for (const [alias, entry] of Object.entries(layer.definition.packages ?? {})) {
      const { canonical, version } = canonicalOf(entry.source, layer.captured);
      const origin = originOf(layer);
      const existing = byAlias.get(alias);
      if (existing) {
        if (existing.canonical !== canonical) {
          throw conflict(
            `alias ${JSON.stringify(alias)} is rebound to another package`,
            [
              diagnostic(`/packages/${alias}/source`, origin.identity, `declared ${canonical}`),
              diagnostic(`/packages/${alias}/source`, existing.origin.identity, `already ${existing.canonical}`),
            ],
            "aliases are stable: an inherited alias cannot point at a different package"
          );
        }
        if (existing.version !== version) {
          throw conflict(
            `alias ${JSON.stringify(alias)} requires two versions of ${canonical}`,
            [
              diagnostic(`/packages/${alias}/source`, origin.identity, version ?? "unknown"),
              diagnostic(`/packages/${alias}/source`, existing.origin.identity, existing.version ?? "unknown"),
            ],
            "versions resolve exactly; fix one declaration rather than picking a winner"
          );
        }
        continue;
      }
      const versions = byCanonical.get(canonical);
      if (versions && versions.version !== version) {
        throw conflict(
          `${canonical} is required at two versions`,
          [
            diagnostic(`/packages/${alias}/source`, origin.identity, version ?? "unknown"),
            diagnostic(`/packages/${versions.alias}/source`, versions.origin.identity, versions.version ?? "unknown"),
          ],
          "versions resolve exactly; a reviewed plan cannot describe both at once"
        );
      }
      const record = { alias, source: entry.source, canonical, version, origin };
      byAlias.set(alias, record);
      byCanonical.set(canonical, { ...record, version });
    }
  }
  return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Fold resource selectors across layers, per package and resource type.
 *
 * A selector's `include` replaces the candidate set and re-includes the paths
 * it lists; its `exclude` then removes paths, so a same-layer exclusion wins.
 * A lower exclusion survives until a higher layer names that path again.
 *
 * A selector without a `kind` keeps that identity rather than being expanded
 * into four resource types: Pi applies the paths to its own per-type filters,
 * and guessing which type a path belongs to would name load surfaces that do
 * not exist.
 *
 * @param {object[]} layers ordered base first
 * @param {object[]} packages the composed aliases, so a selector may name one
 *   an inherited parent declared
 */
export function foldResources(layers, packages = null) {
  const selectors = new Map();
  const declared = packages ?? foldPackages(layers);

  for (const layer of layers) {
    for (const [index, selector] of (layer.definition.resources ?? []).entries()) {
      // An alias is resolved across the chain, so this check belongs here and
      // not in single-declaration validation.
      if (!declared.some((entry) => entry.alias === selector.package)) {
        throw WardrobeError.from("resource references an undeclared package", [
          new WardrobeDiagnostic({
            path: `/resources/${index}/package`,
            reason: `package ${JSON.stringify(selector.package)} is not declared in /packages (${layer.identity})`,
            hint: `declared packages: ${declared.map((entry) => entry.alias).join(", ") || "(none)"} — a preset may only select an alias it or an inherited parent declares`,
          }),
        ]);
      }
      const key = selectorKey(selector.package, selector.kind ?? GENERIC_KIND);
      const state = selectors.get(key) ?? {
        package: selector.package,
        kind: selector.kind ?? GENERIC_KIND,
        generic: selector.kind === undefined,
        candidates: [],
        excluded: new Map(),
        origins: [],
        contributions: [],
      };
      applySelector(state, selector, layer, index);
      selectors.set(key, state);
    }
  }

  const out = [];
  for (const state of [...selectors.values()].sort((a, b) =>
    selectorKey(a.package, a.kind).localeCompare(selectorKey(b.package, b.kind))
  )) {
    const excluded = [...state.excluded.entries()];
    const loaded = state.candidates.filter((path) => !state.excluded.has(path));
    out.push({
      package: state.package,
      kind: state.kind,
      generic: state.generic,
      declared: true,
      include: [...state.candidates].sort(),
      exclude: excluded.map(([path]) => path).sort(),
      loaded,
      excluded: excluded
        .map(([path, entry]) => ({
          path,
          reason: entry.reason,
          origin: entry.origin,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      origins: state.origins,
      // Each layer that wrote this selector, with its own declaration pointer,
      // so a refusal names the declaration that introduced the path.
      contributions: state.contributions,
    });
  }
  return out;
}

/** Fold one layer's selector over the accumulated state for a key. */
function applySelector(state, selector, layer, index) {
  state.contributions.push({
    layer: layer.kind,
    identity: layer.identity,
    path: `/resources/${index}`,
    include: [...(selector.include ?? [])],
  });
  if (selector.include !== undefined) {
    // A supplied include replaces the candidate set and re-includes the paths
    // it names, so a higher layer can undo a lower layer's exclusion.
    state.candidates = [...selector.include];
    for (const path of selector.include) {
      const reinstated = state.excluded.delete(path);
      state.origins.push({
        path,
        action: reinstated ? "re-include" : "include",
        layer: layer.kind,
        identity: layer.identity,
      });
    }
  }
  // Applied after the include, so the same layer's exclusion wins.
  if (selector.exclude !== undefined) {
    for (const path of selector.exclude) {
      state.candidates = state.candidates.filter((candidate) => candidate !== path);
      state.excluded.set(path, {
        reason: `${layer.kind} layer excluded it`,
        origin: { layer: layer.kind, identity: layer.identity },
      });
      state.origins.push({ path, action: "exclude", layer: layer.kind, identity: layer.identity });
    }
  }
}

/**
 * Fold tool selections.
 *
 * Same-layer disable wins; a higher layer may re-enable what a lower layer
 * disabled; nothing re-enables a tool the user or the CLI excluded.
 */
export function foldTools(layers, restrictions = {}) {
  const restricted = new Set(restrictions.disabledTools ?? []);
  const enabled = new Map();
  const disabled = new Map();
  const unmet = [];

  for (const layer of layers) {
    const tools = layer.definition.runtime?.tools ?? {};
    // Enables first, then disables: within one layer the exclusion is final.
    for (const name of tools.enable ?? []) {
      if (restricted.has(name)) {
        unmet.push({
          tool: name,
          layer: layer.kind,
          identity: layer.identity,
          reason: "the user or CLI excluded this tool; a preset cannot re-enable it",
        });
        continue;
      }
      const previous = disabled.get(name);
      disabled.delete(name);
      enabled.set(name, { layer: layer.kind, identity: layer.identity, reenabled: previous ?? null });
    }
    for (const name of tools.disable ?? []) {
      enabled.delete(name);
      disabled.set(name, {
        layer: layer.kind,
        identity: layer.identity,
        reason: restricted.has(name)
          ? "the user or CLI excluded this tool"
          : `${layer.kind} layer disabled it`,
      });
    }
  }

  // A tool the user or the CLI excluded is listed once, with the reason it is
  // unavailable; a layer that also disables it does not add a second entry.
  const blocked = [...restricted]
    .filter((name) => !disabled.has(name))
    .map((name) => ({
      tool: name,
      reason: "the user or CLI excluded this tool",
    }));
  return {
    enabled: [...enabled.entries()]
      .map(([tool, entry]) => ({ tool, layer: entry.layer, identity: entry.identity }))
      .sort((a, b) => a.tool.localeCompare(b.tool)),
    disabled: [
      ...[...disabled.entries()].map(([tool, entry]) => ({
        tool,
        layer: entry.layer,
        identity: entry.identity,
        reason: entry.reason,
      })),
      ...blocked,
    ].sort((a, b) => a.tool.localeCompare(b.tool)),
    restricted: [...restricted].sort(),
    unmet,
  };
}

/** The last layer that declares thinking wins. */
export function foldThinking(layers) {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const thinking = layer.definition.runtime?.thinking;
    if (thinking !== undefined) {
      return { value: thinking, layer: layer.kind, identity: layer.identity };
    }
  }
  return null;
}

/** Appended instructions concatenate in layer order; nothing is removed. */
export function foldPersona(layers) {
  const append = [];
  for (const layer of layers) {
    for (const text of layer.definition.persona?.append ?? []) {
      append.push({ text, layer: layer.kind, identity: layer.identity });
    }
  }
  return { append };
}

/**
 * The executable identity of a composed environment.
 *
 * Only this changes when a new reviewed revision is required; preferences do
 * not appear here.
 */
export function executableIdentity(composed) {
  return {
    packages: composed.packages
      .map((entry) => `${entry.alias}:${entry.canonical}@${entry.version ?? "?"}`)
      .sort(),
    resources: composed.resources
      .flatMap((selector) => selector.loaded.map((path) => `${selector.package}:${selector.kind}:${path}`))
      .sort(),
  };
}

/**
 * Decide whether a change to the environment needs a new reviewed revision.
 *
 * @returns {{requiresNewRevision: boolean, executable: string[], soft: string[]}}
 */
export function classifyChange(previous, next) {
  const before = executableIdentity(previous);
  const after = executableIdentity(next);
  const executable = [
    ...symmetricDifference(before.packages, after.packages),
    ...symmetricDifference(before.resources, after.resources),
  ].sort();
  return {
    requiresNewRevision: executable.length > 0,
    executable,
    soft: softChanges(previous, next),
  };
}

function softChanges(previous, next) {
  const fields = ["tools", "thinking"];
  const changed = fields.filter(
    (field) => JSON.stringify(previous.runtime[field]) !== JSON.stringify(next.runtime[field])
  );
  if (JSON.stringify(previous.persona) !== JSON.stringify(next.persona)) changed.push("persona");
  return changed.sort();
}

function symmetricDifference(before, after) {
  const previous = new Set(before);
  const next = new Set(after);
  return [
    ...[...next].filter((entry) => !previous.has(entry)).map((entry) => `+ ${entry}`),
    ...[...previous].filter((entry) => !next.has(entry)).map((entry) => `- ${entry}`),
  ].sort();
}

/**
 * Refuse an overlay that carries anything executable.
 *
 * An overlay may not add a package, a resource or any other unreviewed
 * dependency: those belong to a reviewed revision, and a change to them needs
 * a new one.
 */
export function assertSoftOverlay(definition, { origin }) {
  const diagnostics = [];
  for (const [key, value] of Object.entries(definition)) {
    const violation = softOverlayViolation(key, `/${key}`);
    if (violation) {
      diagnostics.push(violation);
      continue;
    }
    for (const field of Object.keys(value ?? {})) {
      const nested = softOverlayViolation(key, `/${key}/${field}`, field, key);
      if (nested) diagnostics.push(nested);
    }
  }
  if (diagnostics.length > 0) {
    throw WardrobeError.from(
      `${origin} may only carry soft preferences`,
      diagnostics,
      "loaded resources changed: review a new preset revision instead of overriding it"
    );
  }
  return definition;
}

/**
 * The diagnostic for one field an overlay may not declare, or null.
 *
 * One owner for the rule, so the schema and the composition boundary cannot
 * drift into disagreeing about what an overlay is.
 */
export function softOverlayViolation(key, path, field = null, container = null) {
  if (field === null) {
    if (SOFT_OVERLAY_FIELDS.has(key)) return null;
    return new WardrobeDiagnostic({
      path,
      reason: `an overlay may not declare ${JSON.stringify(key)}`,
      hint: "loaded resources and packages belong to a reviewed revision; review a new preset instead",
    });
  }
  const allowed = container === "runtime" ? SOFT_RUNTIME_FIELDS : SOFT_PERSONA_FIELDS;
  if (allowed.has(field)) return null;
  return new WardrobeDiagnostic({
    path,
    reason:
      container === "runtime"
        ? `an overlay may not declare runtime.${field}`
        : `an overlay may not declare persona.${field}`,
    hint:
      container === "runtime"
        ? "only tools and thinking are idle soft-switchable; model selection belongs to Pi"
        : "only appended instructions may be layered",
  });
}

const SOFT_OVERLAY_FIELDS = new Set(["runtime", "persona"]);
const SOFT_RUNTIME_FIELDS = new Set(["tools", "thinking"]);
const SOFT_PERSONA_FIELDS = new Set(["append"]);

function selectorKey(packageName, kind) {
  return `${packageName}:${kind}`;
}

function originOf(layer) {
  return { layer: layer.kind, identity: layer.identity };
}

function diagnostic(path, identity, reason) {
  return new WardrobeDiagnostic({
    path,
    reason: `${reason} (${identity})`,
    hint: null,
  });
}

function conflict(message, diagnostics, hint) {
  return WardrobeError.from(message, diagnostics, hint);
}
