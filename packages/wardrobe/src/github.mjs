// Controlled GitHub URL normalization.
//
// GitHub URL import is a product requirement, but a loopback transport does not
// validate live GitHub. This module therefore owns URL *normalization* only:
// it turns the shapes a user may paste into one canonical source string, with
// no network access of any kind.

import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const SCP_LIKE = /^(?:git@)([^:/]+):(.+)$/;

/**
 * Normalize a GitHub reference into `github:<owner>/<repo>#<presetPath>`.
 *
 * Accepted: `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo`,
 * `git@github.com:owner/repo.git`, with or without a trailing `.git`, plus an
 * optional `#<presetPath>` fragment.
 */
export function normalizeGithub(input, path = "/source") {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw WardrobeError.from("GitHub source is empty", [
      new WardrobeDiagnostic({ path, reason: "expected owner/repo or a github.com URL" }),
    ]);
  }

  const [reference, presetPath] = splitFragment(raw);
  const [owner, repo] = splitRepository(reference, path);

  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw WardrobeError.from("GitHub repository path is not usable", [
      new WardrobeDiagnostic({
        path,
        reason: `${JSON.stringify(reference)} is not owner/repo`,
        hint: "e.g. github:owner/repo or https://github.com/owner/repo.git",
      }),
    ]);
  }
  if (presetPath && presetPath.startsWith("/")) {
    throw WardrobeError.from("GitHub preset path must be relative", [
      new WardrobeDiagnostic({ path, reason: `${presetPath} is absolute` }),
    ]);
  }
  const suffix = presetPath ? `#${presetPath.replace(/^\/+|\/+$/g, "")}` : "";
  return `github:${owner}/${repo}${suffix}`;
}

function splitFragment(raw) {
  const index = raw.indexOf("#");
  if (index < 0) return [raw, null];
  return [raw.slice(0, index), raw.slice(index + 1)];
}

function splitRepository(rawReference, path) {
  const reference = rawReference.replace(/^github:/i, "");
  const scp = SCP_LIKE.exec(reference);
  if (scp) {
    if (!GITHUB_HOSTS.has(scp[1].toLowerCase())) {
      throw WardrobeError.from("unsupported git host", [
        new WardrobeDiagnostic({
          path,
          reason: `${scp[1]} is not github.com`,
          hint: "a git: source is required for other hosts",
        }),
      ]);
    }
    return splitPath(scp[2], path);
  }

  const withoutScheme = reference.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const segments = withoutScheme.split("/");
  if (segments.length > 2 && GITHUB_HOSTS.has(segments[0].toLowerCase())) {
    return splitPath(segments.slice(1).join("/"), path);
  }
  return splitPath(withoutScheme, path);
}

function splitPath(value, path) {
  const segments = value.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw WardrobeError.from("GitHub repository path is not usable", [
      new WardrobeDiagnostic({
        path,
        reason: `expected exactly owner/repo, found ${segments.length} segment(s)`,
        hint: "e.g. github:owner/repo",
      }),
    ]);
  }
  return [segments[0], segments[1]];
}
