// Source specifications and preset identity.
//
// A preset's identity is source-qualified: two different sources may declare
// the same `id`, so an id on its own is only a selector when it is unique.

import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { isExactVersion } from "./semver.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Parse a declared source.
 *
 * `.` means the package that contains the definition itself, so a preset can
 * name the package it ships in without knowing its published coordinates.
 *
 * @returns {{kind: "self"|"npm"|"git", package?: string, version?: string, url?: string, ref?: string, exact: boolean}}
 */
export function parseSource(source, path = "/source") {
  if (source === ".") return { kind: "self", exact: true };

  const [scheme, rest] = splitOnce(source, ":");
  if (scheme === "npm") {
    const at = rest.lastIndexOf("@");
    if (at <= 0) {
      throw WardrobeError.from("npm source must pin an exact version", [
        new WardrobeDiagnostic({
          path,
          reason: `expected npm:<name>@<exact-version>, found ${JSON.stringify(source)}`,
          hint: "a preset never declares a package version that could float",
        }),
      ]);
    }
    const name = rest.slice(0, at);
    const version = rest.slice(at + 1);
    if (!isExactVersion(version)) {
      throw WardrobeError.from("npm source must pin an exact version", [
        new WardrobeDiagnostic({
          path,
          reason: `${version ? JSON.stringify(version) : "missing version"} is not an exact version`,
          hint: "a preset never declares a package version that could float",
        }),
      ]);
    }
    return { kind: "npm", package: name, version, exact: true };
  }

  if (scheme === "git") {
    const at = rest.lastIndexOf("@");
    const url = at > 0 ? rest.slice(0, at) : rest;
    const ref = at > 0 ? rest.slice(at + 1) : null;
    if (!url) {
      throw WardrobeError.from("git source needs a repository URL", [
        new WardrobeDiagnostic({ path, reason: "empty repository URL" }),
      ]);
    }
    if (!FULL_SHA.test(ref ?? "")) {
      throw WardrobeError.from("git source must pin a full commit SHA", [
        new WardrobeDiagnostic({
          path,
          reason: ref
            ? `${JSON.stringify(ref)} is not a full 40-character commit SHA`
            : "no commit was pinned",
          hint: "a preset never points at a branch or tag; use the full SHA",
        }),
      ]);
    }
    return { kind: "git", url, ref, exact: true };
  }

  throw WardrobeError.from("unsupported source scheme", [
    new WardrobeDiagnostic({
      path,
      reason: `expected ., npm: or git:, found ${JSON.stringify(scheme)}`,
      hint: "local paths are not sources; reference '.', publish the package, or use git:",
    }),
  ]);
}

/** Split a qualified selector into its source and preset id. */
function parseSelector(selector) {
  // `#` is the only qualifier separator: sources contain `/` and `:`, and
  // preset ids may themselves be namespaced with `/`.
  const hash = selector.lastIndexOf("#");
  if (hash >= 0) {
    return { source: selector.slice(0, hash), id: selector.slice(hash + 1) };
  }
  return { source: null, id: selector };
}

export function identityKey({ source, id }) {
  return `${source}#${id}`;
}

/**
 * A preset's identity, at the level a binding cares about.
 *
 * The identity a capture records pins a commit or an exact version, which is
 * right for a revision and wrong for a preset: two revisions of one preset would
 * then be two presets, and a follow binding could never see its own siblings.
 * A preset is its canonical source repository plus its declared id; the pin is
 * what a revision adds.
 */
export function repositoryKeyOf({ source, id }) {
  return `${repositoryOf(source)}#${id}`;
}

/**
 * The canonical repository of a source locator, with any pin removed.
 *
 * A pinned Git locator carries its commit twice (`…@<sha>@<sha>`) and a pinned
 * npm locator carries its version, so both are removed. Only a segment that
 * looks like a commit or a version goes: a local snapshot path may
 * legitimately contain an `@`, and a repository is not its own pin.
 */
export function repositoryOf(source) {
  if (typeof source !== "string") return String(source ?? "");
  let cut = source;
  for (;;) {
    const at = cut.lastIndexOf("@");
    if (at <= 0) return cut;
    const tail = cut.slice(at + 1);
    if (!isCommit(tail) && !isVersion(tail)) return cut;
    cut = cut.slice(0, at);
  }
}

const isCommit = (segment) => /^[0-9a-f]{7,40}$/.test(segment);
const isVersion = (segment) => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(segment);


/**
 * Resolve a command-line selector against the known presets.
 *
 * A short id resolves only when it is unique. An ambiguous short id is refused
 * with the candidates, because silently picking one of two same-named presets
 * from different sources is exactly the mistake this guards against.
 */
export function resolveSelector(selector, presets) {
  const { source, id } = parseSelector(selector.trim());
  if (!source) {
    const matches = presets.filter((preset) => preset.id === id);
    if (matches.length === 1) return { ok: true, preset: matches[0] };
    if (matches.length === 0) return notFound(selector, presets);
    return {
      ok: false,
      error: WardrobeError.from(
        `${selector} is ambiguous: ${matches.length} presets share that id`,
        matches.map(
          (preset) =>
            new WardrobeDiagnostic({
              path: "",
              reason: `candidate: ${identityKey(preset)}`,
            })
        ),
        "qualify the selector with its source, e.g. " +
          matches.map((preset) => identityKey(preset)).join(" or ")
      ),
    };
  }
  const match = presets.find((preset) => preset.source === source && preset.id === id);
  return match
    ? { ok: true, preset: match }
    : notFound(selector, presets);
}

function notFound(selector, presets) {
  return {
    ok: false,
    error: WardrobeError.from(
      `no preset matches ${JSON.stringify(selector)}`,
      presets.length === 0
        ? []
        : [
            new WardrobeDiagnostic({
              path: "",
              reason: `known presets: ${presets.map((preset) => identityKey(preset)).join(", ")}`,
            }),
          ],
      "run /wardrobe list to see what is available"
    ),
  };
}

function splitOnce(value, separator) {
  const index = value.indexOf(separator);
  if (index < 0) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}
