// Git source capture.
//
// Retrieval is real Git: a repository is cloned into an owned root at a full
// commit, and the captured tree is what the review plan is built from. Nothing
// in the tree is executed — no install script, no Extension import.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { findPresetDeclarations } from "./presets.mjs";
import { git } from "./proc.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Query a remote git repository using `git ls-remote` and return the 40-character commit SHA.
 *
 * @param {string} url git repository URL
 * @param {string} [ref="HEAD"] ref name or HEAD
 * @param {object} [env={}] child environment
 * @returns {Promise<string>} 40-character commit SHA
 */
export async function resolveGitRef(url, ref = "HEAD", env = {}) {
  let output;
  try {
    output = await git(["ls-remote", "-q", url, ref], { env });
  } catch (error) {
    throw WardrobeError.from("cannot query remote git repository", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: error instanceof Error ? error.message : String(error),
        hint: `ensure git can access ${url}`,
      }),
    ]);
  }
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw WardrobeError.from("cannot resolve git reference", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `remote ${url} has no reference matching ${JSON.stringify(ref)}`,
        hint: "check repository name or ref",
      }),
    ]);
  }
  // If an annotated tag is matched, prefer the peeled tag ^{} pointing to the commit
  const peeled = lines.find((line) => line.includes("^{}"));
  const targetLine = peeled ?? lines[0];
  const [sha] = targetLine.split(/\s+/);
  if (!FULL_SHA.test(sha)) {
    throw WardrobeError.from("resolved git ref is not a full commit SHA", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `expected 40-character SHA, found ${JSON.stringify(sha)}`,
      }),
    ]);
  }
  return sha;
}

/**
 * Clone `url` at `ref` into `root` and return what was captured.
 *
 * @returns {{root: string, url: string, commit: string, presets: {path: string, digest: string}[]}}
 */
export async function captureGitSource({ url, ref, root, env }) {
  if (!FULL_SHA.test(ref ?? "")) {
    throw WardrobeError.from("git source must pin a full commit SHA", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: ref ? `${JSON.stringify(ref)} is not a full 40-character commit SHA` : "no commit pinned",
        hint: "a review plan is only immutable when it names the commit it read",
      }),
    ]);
  }

  // Re-capturing the same source must start clean, or `remote add` fails on the
  // second attempt and discovery becomes order-dependent.
  rmSync(root, { recursive: true, force: true });
  await git(["init", "-q", root], { env });
  await git(["-C", root, "remote", "add", "origin", url], { env });
  // Fetch the pinned commit specifically. A shallow fetch is deliberately not
  // used: the dumb HTTP transport does not support shallow capabilities, and
  // discovery must work against every transport a source may be served over.
  await git(["-C", root, "fetch", "-q", "origin", ref], { env });
  await git(["-C", root, "checkout", "-q", "FETCH_HEAD"], { env });

  const commit = await git(["-C", root, "rev-parse", "HEAD"], { env });
  if (commit !== ref) {
    throw WardrobeError.from("captured commit does not match the requested ref", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `requested ${ref}, captured ${commit}`,
      }),
    ]);
  }

  return {
    root,
    url,
    commit,
    presets: findPresetDeclarations(root),
  };
}

/** Declarations at the repository root or one level below it. */
/** A digest of the captured tree, for detecting a changed source. */
export async function treeDigest(root, commit, env) {
  const tracked = await git(["-C", root, "ls-files", "-z"], { env });
  const files = tracked.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  hash.update(`${commit}\0`);
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Resolve a package-relative resource path inside a captured package.
 *
 * Refuses absolute paths, traversal, and symlinks: a resource that escapes its
 * package, or arrives through a link, is not something the review can describe.
 */
export function resolvePackagePath(packageRoot, resourcePath, pathForDiagnostics) {
  if (isAbsolute(resourcePath)) {
    throw escape(pathForDiagnostics, resourcePath, "path is absolute");
  }
  // Normalise the root first: a caller-supplied path may carry a trailing
  // separator, which would make every containment check fail open.
  const root = resolve(packageRoot);
  const candidate = resolve(root, resourcePath);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw escape(pathForDiagnostics, resourcePath, "path escapes the package");
  }
  const link = lstatSync(candidate, { throwIfNoEntry: false });
  if (!link) {
    throw escape(pathForDiagnostics, resourcePath, "path is missing from the captured package");
  }
  if (link.isSymbolicLink()) {
    throw escape(pathForDiagnostics, resourcePath, "path is a symbolic link");
  }
  const realRoot = realpathSync(root);
  const real = realpathSync(candidate);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw escape(pathForDiagnostics, resourcePath, "path resolves outside the package");
  }
  return candidate;
}

function escape(path, value, reason) {
  return WardrobeError.from("resource path refused", [
    new WardrobeDiagnostic({
      path,
      reason: `${reason}: ${JSON.stringify(value)}`,
      hint: "resources are package-relative paths inside the captured package",
    }),
  ]);
}

function digestOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
