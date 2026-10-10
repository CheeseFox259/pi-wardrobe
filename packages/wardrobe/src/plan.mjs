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
 */
export function buildPlan({
  identity,
  definition,
  source,
  packages,
  resources,
  packageSurfaces,
  selfSurfaces,
}) {
  const plan = {
    identity,
    declaration: {
      name: definition.name,
      version: definition.version,
      schemaVersion: definition.schemaVersion,
    },
    source,
    installationSurfaces: packages.map((entry) => ({
      alias: entry.alias,
      source: entry.source,
      resolvesTo: entry.resolvesTo,
      artifact: entry.artifact,
      installsCode: entry.hasInstallScript === true,
      scripts: entry.scripts ?? [],
    })),
    resourceSelectors: resources.map((resource) => ({
      alias: resource.alias,
      package: resource.package,
      kind: resource.kind ?? "resources",
      include: [...resource.include].sort(),
      exclude: [...(resource.exclude ?? [])].sort(),
    })),
    loadSurfaces: [
      ...selfSurfaces.map((surface) => ({ from: identity.source, surface })),
      ...packageSurfaces.map((surface) => ({ from: surface.alias, surface: surface.surface })),
    ].sort((a, b) => a.surface.localeCompare(b.surface)),
    artifacts: [
      ...packages.map((entry) => artifactIdOf(entry)),
      ...resources.flatMap((resource) =>
        [...resource.include].map((path) => `${resource.package}:${path}`)
      ),
    ]
      .filter(Boolean)
      .sort(),
  };
  return { plan, digest: digestOf(plan) };
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
  const { digest, ...body } = sealed;
  return digestOf(body) === digest;
}
