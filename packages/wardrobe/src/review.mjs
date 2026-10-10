// Building a review plan from a captured source.
//
// Everything here is read-only with respect to Pi: it resolves declared npm
// package sources to their exact artifacts and enumerates the surfaces the
// preset would load. It never installs, and never imports package code.

import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { parseSource } from "./identity.mjs";
import { buildPlan, planIdOf, sealPlan } from "./plan.mjs";
import { resolveNpmPackage } from "./npm-source.mjs";
import { resolvePackagePath } from "./git-source.mjs";

/**
 * Build and seal the plan for one captured preset.
 *
 * @returns {object} the sealed plan, including its digest
 */
export async function planFor({ captured, preset, registry, env, fetchImpl }) {
  const definition = preset.definition;
  const packages = definition.packages ?? {};
  const resources = definition.resources ?? [];

  const resolvedPackages = [];
  for (const [alias, entry] of Object.entries(packages)) {
    resolvedPackages.push(
      await resolvePackageSource({ alias, entry, captured, registry, env, fetchImpl })
    );
  }

  const checkedResources = resources.map((resource, index) => {
    if (!Object.hasOwn(packages, resource.package)) {
      throw WardrobeError.from("resource references an undeclared package", [
        new WardrobeDiagnostic({
          path: `/resources/${index}/package`,
          reason: `${JSON.stringify(resource.package)} is not declared`,
        }),
      ]);
    }
    return resource;
  });

  // Load surfaces come from two independent places: the resource selectors this
  // preset declares, and the manifest of a package captured alongside it.
  // Deriving both from `resources` would count every selector twice.
  // A self-contained preset ships the resources it selects, so those paths can
  // be checked now. Resources of external packages cannot: their contents only
  // exist after install, and that is where they are checked.
  checkSelfContainedResources(captured, preset, definition);

  const selfSurfaces = capturedManifestSurfaces(captured, preset);
  const selectorSurfaces = checkedResources.map((resource) => ({
    alias: resource.package,
    surface: `${resource.kind ?? "resources"}:${resource.package}/${[...resource.include].sort().join(",")}`,
  }));

  const { plan } = buildPlan({
    identity: { source: preset.source, id: definition.id },
    definition,
    source: {
      kind: captured.kind,
      locator: captured.locator,
      commit: captured.commit ?? null,
      version: captured.version ?? null,
      tarball: captured.tarball ?? null,
      integrity: captured.integrity ?? null,
      treeDigest: captured.treeDigest,
      declarationPath: preset.path,
      declarationDigest: preset.digest,
    },
    packages: resolvedPackages,
    resources: checkedResources,
    packageSurfaces: selectorSurfaces,
    selfSurfaces,
  });

  const sealed = { ...plan, planId: planIdOf(plan.identity, plan.source) };
  return sealPlan(sealed);
}

/**
 * Resolve one declared package source.
 *
 * `.` resolves to the pinned native source of the package the declaration came
 * from — never to a local path, which would misrepresent loading as installing.
 */
async function resolvePackageSource({ alias, entry, captured, registry, env, fetchImpl }) {
  const parsed = parseSource(entry.source, `/packages/${alias}/source`);

  if (parsed.kind === "self") {
    return {
      alias,
      source: entry.source,
      resolvesTo: captured.locator,
      artifact: artifactOfCapture(captured),
      hasInstallScript: captured.hasInstallScript === true,
    };
  }

  if (parsed.kind === "git") {
    return {
      alias,
      source: entry.source,
      resolvesTo: parsed.url,
      artifact: { kind: "git", commit: parsed.ref, url: parsed.url },
      hasInstallScript: entry.hasInstallScript === true,
    };
  }

  if (!registry) {
    throw WardrobeError.from("npm source needs a registry to be reviewed", [
      new WardrobeDiagnostic({ path: `/packages/${alias}/source`, reason: "no registry configured" }),
    ]);
  }
  const meta = await resolveNpmPackage({
    name: parsed.package,
    version: parsed.version,
    registry,
    fetchImpl,
  });
  return {
    alias,
    source: entry.source,
    resolvesTo: `npm:${meta.name}@${meta.version}`,
    artifact: { kind: "npm", tarball: meta.tarball, integrity: meta.integrity },
    hasInstallScript: meta.hasInstallScript,
    scripts: Object.keys(meta.scripts),
  };
}

function artifactOfCapture(captured) {
  if (captured.kind === "npm") {
    return { kind: "npm", tarball: captured.tarball, integrity: captured.integrity };
  }
  return { kind: "git", url: captured.url, commit: captured.commit };
}

/**
 * Load surfaces declared by the manifest of a package captured in this source.
 *
 * Only what the manifest actually declares is named. Nothing is inferred from
 * the file system, so the preview cannot claim a surface that does not exist.
 */
function capturedManifestSurfaces(captured, preset) {
  const candidates = [
    join(captured.root, dirname(preset.path), "package.json"),
    join(captured.root, "package.json"),
  ];
  const surfaces = new Set();
  for (const manifestPath of candidates) {
    if (!lstatSync(manifestPath, { throwIfNoEntry: false })?.isFile()) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    for (const surface of manifestSurfaces(manifest)) surfaces.add(surface);
  }
  return [...surfaces].sort();
}

function manifestSurfaces(manifest) {
  const pi = manifest.pi ?? {};
  return [
    ...(pi.extensions ?? []).map((file) => `extension:${file}`),
    ...(pi.skills ?? []).map((name) => `skills:${name}`),
    ...(pi.prompts ?? []).map((name) => `prompts:${name}`),
    ...(pi.themes ?? []).map((name) => `themes:${name}`),
  ];
}

/**
 * Validate that every declared resource path exists inside the captured source.
 *
 * Only meaningful for self-contained declarations whose package ships in the
 * same capture; anything else is resolved at install time, after approval.
 */
export function checkSelfContainedResources(captured, preset, definition) {
  const packages = definition.packages ?? {};
  for (const [index, resource] of (definition.resources ?? []).entries()) {
    if (packages[resource.package]?.source !== ".") continue;
    // A self source is the package that carries this definition, so the package
    // root is the directory holding the declaration — not a `resources/` folder.
    const packageRoot = join(captured.root, dirname(preset.path));
    for (const include of resource.include ?? []) {
      resolvePackagePath(packageRoot, include, `/resources/${index}/include`);
    }
  }
}
