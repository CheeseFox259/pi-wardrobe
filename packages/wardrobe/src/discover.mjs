// Source discovery.
//
// A source argument is resolved to a captured, immutable copy on disk, plus
// the presets it declares. Discovery never installs a package and never imports
// an Extension: it reads files and registry metadata only.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { captureGitSource, resolveGitRef, treeDigest } from "./git-source.mjs";
import { githubUrl, isGithubLocator, normalizeGithub } from "./github.mjs";
import { parseSource } from "./identity.mjs";
import { captureNpmSource } from "./npm-import.mjs";
import { validateDefinition } from "./schema.mjs";

/** Split a source argument into its locator and an optional preset path. */
export function splitSource(argument) {
  const hash = argument.indexOf("#");
  if (hash < 0) return { locator: argument, presetPath: null };
  return { locator: argument.slice(0, hash), presetPath: argument.slice(hash + 1) || null };
}

/**
 * Capture a source and return the presets it declares.
 *
 * @returns {Promise<{kind: string, locator: string, identity: string, treeDigest: string, presets: object[]}>}
 */
export async function captureSource(argument, { workDir, env, registry, fetchImpl } = {}) {
  const { locator, presetPath } = splitSource(String(argument ?? "").trim());
  if (!locator) {
    throw WardrobeError.from("no source given", [
      new WardrobeDiagnostic({ path: "/source", reason: "expected npm:<name>@<version> or git:<url>@<sha>" }),
    ]);
  }

  if (locator.startsWith("github:") || isGithubLocator(locator)) {
    const normalized = normalizeGithub(locator);
    const withoutScheme = normalized.slice("github:".length);
    const hashIndex = withoutScheme.indexOf("#");
    const repository = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;
    const embeddedPath = hashIndex >= 0 ? withoutScheme.slice(hashIndex + 1) : null;
    const effectivePresetPath = presetPath ?? embeddedPath;
    const url = githubUrl(repository, env);
    // Resolve commit SHA from remote Git HEAD rather than guessing from locator fragment
    const commit = await resolveGitRef(url, "HEAD", env);
    return captureGit({
      url,
      ref: commit,
      presetPath: effectivePresetPath,
      workDir,
      env,
      identity: `github:${repository}${effectivePresetPath ? `#${effectivePresetPath}` : ""}`,
    });
  }

  const parsed = parseSource(locator);
  if (parsed.kind === "self") {
    throw WardrobeError.from("a source must be npm: or git:", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: '"." only means "the package this declaration ships in"',
      }),
    ]);
  }
  if (parsed.kind === "npm") {
    return captureNpm({ ...parsed, presetPath, workDir, env, registry, fetchImpl });
  }
  return captureGit({
    url: parsed.url,
    ref: parsed.ref,
    presetPath,
    workDir,
    env,
    identity: locator,
  });
}

async function captureGit({ url, ref, presetPath, workDir, env, identity }) {
  if (!ref) {
    throw WardrobeError.from("git source needs a full commit SHA", [
      new WardrobeDiagnostic({ path: "/source", reason: "no commit was pinned" }),
    ]);
  }
  const root = resolve(workDir, `git-${shortHash(`${identity}@${ref}`)}`);
  const captured = await captureGitSource({ url, ref, root, env });
  return {
    kind: "git",
    locator: identity,
    url,
    commit: captured.commit,
    root,
    treeDigest: await treeDigest(captured.root, captured.commit, env),
    presets: readPresets(root, captured.presets, presetPath, `${identity}@${captured.commit}`),
  };
}

async function captureNpm({ package: name, version, presetPath, workDir, env, registry, fetchImpl }) {
  if (!registry) {
    throw WardrobeError.from("npm discovery needs a registry", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: "no registry is configured",
        hint: "Wardrobe only reads a registry it was pointed at explicitly",
      }),
    ]);
  }
  const root = resolve(workDir, `npm-${shortHash(`${name}@${version}`)}`);
  const captured = await captureNpmSource({ name, version, registry, root, env, fetchImpl });
  const identity = `npm:${name}@${version}`;
  return {
    kind: "npm",
    locator: identity,
    name,
    version,
    integrity: captured.meta.integrity,
    tarball: captured.meta.tarball,
    root,
    treeDigest: contentDigest(root),
    presets: readPresets(root, captured.presets, presetPath, identity),
  };
}

/**
 * Parse and validate every preset definition the capture contains.
 *
 * The returned entries are presets as users refer to them; each carries the
 * validated `definition` the rest of the manager reasons about.
 */
function readPresets(root, captured, presetPath, identity) {
  return captured
    .filter(
      (entry) =>
        !presetPath || entry.path === presetPath || entry.path.startsWith(`${presetPath}/`)
    )
    .map((entry) => {
      const raw = JSON.parse(readFileSync(join(root, entry.path), "utf8"));
      const result = validateDefinition(raw, { origin: entry.path });
      if (!result.ok) throw result.error;
      return {
        path: entry.path,
        digest: entry.digest,
        root,
        source: identity,
        definition: result.definition,
      };
    });
}

/** A stable digest of every captured file, so a changed source invalidates a plan. */
export function contentDigest(root) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${entry.name}\0`);
        walk(path);
      } else {
        hash.update(`f:${entry.name}\0`);
        hash.update(readFileSync(path));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
