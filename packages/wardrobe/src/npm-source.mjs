// npm source resolution.
//
// Discovery reads registry metadata only: an exact version, its tarball URL and
// its integrity hash, plus the install-script metadata a reviewer needs. It
// never installs the package and never runs a lifecycle script — that belongs
// to the install step, after approval.

import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { isExactVersion } from "./semver.mjs";

/** Encoded registry path for a package name (`@scope/name` included). */
export function registryPath(name) {
  return name.replace(/\//g, "%2f");
}

/**
 * Resolve an exact npm version without installing it.
 *
 * @returns {{name, version, tarball, integrity, shasum, hasInstallScript, scripts, digest}}
 */
export async function resolveNpmPackage({ name, version, registry, fetchImpl = fetch }) {
  if (!isExactVersion(version)) {
    throw WardrobeError.from("npm source must pin an exact version", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `${JSON.stringify(version)} is not an exact version`,
        hint: "a review plan must name one artifact, never a range",
      }),
    ]);
  }
  const url = `${registry.replace(/\/$/, "")}/${registryPath(name)}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw WardrobeError.from("npm metadata could not be read", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `${url} returned ${response.status}`,
      }),
    ]);
  }
  const packument = await response.json();
  const entry = packument.versions?.[version];
  if (!entry) {
    throw WardrobeError.from("npm version is not published", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `${name}@${version} is absent`,
        hint: `available: ${Object.keys(packument.versions ?? {}).join(", ") || "(none)"}`,
      }),
    ]);
  }
  if (!entry.dist?.integrity || !entry.dist?.tarball) {
    throw WardrobeError.from("npm metadata is incomplete", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `${name}@${version} has no integrity or tarball`,
        hint: "an artifact without an integrity hash cannot be approved",
      }),
    ]);
  }
  return {
    name,
    version,
    tarball: entry.dist.tarball,
    integrity: entry.dist.integrity,
    shasum: entry.dist.shasum ?? null,
    hasInstallScript: entry.hasInstallScript === true,
    scripts: entry.scripts ?? {},
  };
}
