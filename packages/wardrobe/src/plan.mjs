// The immutable review plan.
//
// A plan is the whole of what a user is asked to approve: the exact artifacts
// that would be installed, the exact resources that would be loaded, and every
// installation surface involved. Its digest covers that content, so an approval
// can only ever apply to the plan the user actually saw.

import { createHash } from "node:crypto";

/** Stable JSON: key order must never change what a digest means. */
export function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalise(value[key])])
    );
  }
  return value;
}

export function digestOf(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalise(value)))
    .digest("hex");
}

/** A short, quotable identifier for a plan, derived from its content. */
export function planIdOf(identity, source) {
  return digestOf({ identity, source }).slice(0, 16);
}

/**
 * Assemble the plan body.
 *
 * `loadSurfaces` names every resource that would become active; `artifacts`
 * names every exact file or tarball the plan covers. Neither is a promise that
 * anything has been installed.
 *
 * The plan describes a *composed* environment: inherited declarations, the
 * user's own soft overlay, the effective selectors and the effective
 * preferences all appear with the layer each value came from.
 */
export function buildPlan({
  identity,
  definition,
  source,
  layers,
  packages,
  resources,
  runtime,
  persona,
  executable,
  agent,
}) {
  const plan = {
    identity,
    ...(agent ? { agent } : {}),
    declaration: {
      name: definition.name,
      version: definition.version,
      schemaVersion: definition.schemaVersion,
      // The declared compatibility range is part of what a revision *is*: it
      // says which Pi builds the approved environment may run on, so it belongs
      // in the plan and in the configuration the revision lock covers.
      compatibility: definition.compatibility ?? null,
    },
    source,
    layers: [...(layers ?? [])].map(describe),
    installationSurfaces: packages.map((entry) => ({
      alias: entry.alias,
      source: entry.source,
      resolvesTo: entry.resolvesTo,
      artifact: entry.artifact,
      ...(entry.resourceRoot ? { resourceRoot: entry.resourceRoot } : {}),
      installsCode: entry.hasInstallScript === true,
      scripts: entry.scripts ?? [],
      declaredBy: entry.origin ?? null,
    })),
    // Only resources a selector actually selects are named. A package and type
    // with no selector anywhere loads nothing, so claiming a load surface for
    // it would describe code the user never approved loading.
    resourceSelectors: resources.map((resource) => ({
      alias: resource.package,
      package: resource.package,
      kind: resource.kind,
      generic: resource.generic === true,
      include: [...resource.include].sort(),
      exclude: [...(resource.exclude ?? [])].sort(),
      loaded: [...resource.loaded].sort(),
      excluded: (resource.excluded ?? []).map((entry) => ({
        path: entry.path,
        reason: entry.reason,
        layer: entry.origin.layer,
        identity: entry.origin.identity,
      })),
      declaredBy: resource.origins ?? [],
    })),
    loadSurfaces: resources
      .flatMap((resource) =>
        resource.loaded.map((path) => ({
          from: resource.package,
          surface: `${resource.kind}:${resource.package}/${path}`,
        }))
      )
      .sort((a, b) => a.surface.localeCompare(b.surface)),
    runtime: runtime ?? null,
    persona: persona ?? null,
    executable: executable ?? null,
    artifacts: [
      ...packages.map((entry) => artifactIdOf(entry)),
      ...resources.flatMap((resource) =>
        resource.loaded.map((path) => `${resource.package}:${path}`)
      ),
    ]
      .filter(Boolean)
      .sort(),
  };
  return { plan, digest: digestOf(plan) };
}

/** The layer description stored in a plan: identity and revision, no content. */
function describe(layer) {
  return {
    kind: layer.kind,
    identity: layer.identity,
    source: layer.source ?? null,
    declarationPath: layer.declarationPath ?? null,
    declarationDigest: layer.declarationDigest ?? null,
  };
}

/** The exact artifact a package resolves to, named the way a user approved it. */
function artifactIdOf(entry) {
  if (entry.artifact?.kind === "npm") return entry.artifact.tarball;
  if (entry.artifact?.kind === "git") return `${entry.artifact.url}@${entry.artifact.commit}`;
  return null;
}

/** Attach the digest to a plan body, producing the sealed plan. */
export function sealPlan(plan) {
  return { ...plan, digest: digestOf(plan) };
}

/** True when a sealed plan still hashes to its recorded digest. */
export function digestMatches(sealed) {
  if (!sealed?.digest) return false;
  // `approved` records that the plan was approved; it is not part of what was
  // approved, so recording an approval must not invalidate the plan.
  const { digest, approved, ...body } = sealed;
  void approved;
  return digestOf(body) === digest;
}
