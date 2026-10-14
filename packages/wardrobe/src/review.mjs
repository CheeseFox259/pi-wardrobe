// Building a review plan from a captured source and everything it inherits.
//
// Everything here is read-only with respect to Pi: it resolves declared npm
// package sources to their exact artifacts and enumerates the resources the
// composed preset would load. It never installs, and never imports package
// code.

import { dirname, join } from "node:path";
import { compose, classifyChange, describeLayer, executableIdentity } from "./compose.mjs";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { captureSource } from "./discover.mjs";
import { parseSource } from "./identity.mjs";
import { resolveChain } from "./inherit.mjs";
import { buildPlan, planIdOf, sealPlan } from "./plan.mjs";
import { resolveNpmPackage } from "./npm-source.mjs";
import { resolvePackagePath } from "./git-source.mjs";

/**
 * Resolve a captured preset into ordered layers and compose them.
 *
 * Parent sources are captured through the same path the top-level source went
 * through, so an inherited declaration is read at its own pinned source rather
 * than trusted from a declaration or from disk.
 *
 * @param {{captured: object, preset: object, workDir: string, registry?: string,
 *   env?: object, fetchImpl?: Function, overlays?: object[], restrictions?: object}} input
 * @returns {Promise<{layers: object[], composed: object, executable: object}>}
 */
export async function composeFor({
  captured,
  preset,
  workDir,
  registry,
  env = {},
  fetchImpl,
  overlays = [],
  restrictions = {},
}) {
  const capture = (locator) =>
    captureSource(locator, {
      workDir,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
      registry,
      fetchImpl,
    });

  const declared = await resolveChain({ captured, preset, capture });
  const layers = [
    ...declared,
    ...overlays.map((overlay) => ({
      kind: overlay.kind,
      identity: overlay.identity,
      captured: null,
      preset: null,
      definition: overlay.definition,
    })),
  ];

  const composed = compose(layers, { restrictions });
  // Self resources ship with the declaration that names them, so their paths
  // can only be checked against the capture that declaration came from — which
  // may be an ancestor's capture, not the preset's own.
  checkSelfContainedResources(declared, composed);
  return {
    layers,
    composed,
    executable: executableIdentity(composed),
    // What an overlay changed. Overlays are soft by construction, so this is
    // the check that a session preference did not quietly require a new
    // reviewed revision.
    change: classifyChange(compose(declared, { restrictions }), composed),
  };
}

/**
 * Build and seal the plan for one captured preset.
 *
 * @returns {Promise<object>} the sealed plan, including its digest
 */
export async function planFor(options) {
  const { captured, preset } = options;
  const { layers, composed, executable } = await composeFor(options);

  const packages = [];
  for (const entry of composed.packages) {
    const layer = layers.find(
      (candidate) =>
        candidate.kind === entry.origin.layer && candidate.identity === entry.origin.identity
    );
    const declaration = layer?.definition.packages?.[entry.alias];
    if (!declaration) continue;
    packages.push({
      ...(await resolvePackageSource({
        alias: entry.alias,
        entry: declaration,
        captured: layer.captured,
        registry: options.registry,
        env: options.env,
        fetchImpl: options.fetchImpl,
      })),
      origin: entry.origin,
    });
  }

  const { plan } = buildPlan({
    identity: { source: preset.source, id: preset.definition.id },
    definition: preset.definition,
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
    layers: layers.map(describeLayer),
    packages,
    resources: composed.resources,
    runtime: composed.runtime,
    persona: composed.persona,
    executable,
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
    // If captured from git (including github:), resolve to the pinned native git URL@commit
    const pinnedGit =
      captured.kind === "git" && captured.url && captured.commit
        ? `git:${captured.url}@${captured.commit}`
        : null;
    return {
      alias,
      source: entry.source,
      resolvesTo: pinnedGit ?? captured.locator,
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
 * Validate that every selected resource path exists inside its captured source.
 *
 * Only meaningful for self-contained declarations whose package ships in the
 * same capture; anything else is resolved at install time, after approval. A
 * selector may name an alias an ancestor declared, so the capture is looked up
 * through the composition rather than through the layer that wrote the selector.
 */
export function checkSelfContainedResources(declaredLayers, composed) {
  const selfAliases = new Map();
  for (const layer of declaredLayers) {
    for (const [alias, entry] of Object.entries(layer.definition.packages ?? {})) {
      if (entry.source === ".") selfAliases.set(alias, layer);
    }
  }

  for (const selector of composed.resources) {
    const layer = selfAliases.get(selector.package);
    if (!layer) continue;
    // A self source is the package that carries that definition, so the package
    // root is the directory holding the declaration — not a `resources/` folder.
    const packageRoot = join(layer.captured.root, dirname(layer.preset.path));
    for (const contribution of selector.contributions) {
      for (const path of contribution.include) {
        resolvePackagePath(packageRoot, path, `${contribution.path}/include`);
      }
    }
  }
}
