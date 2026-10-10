// npm import: capture a published package that carries a preset definition,
// without running anything it contains.
//
// Discovery downloads the tarball, verifies its integrity against the
// registry's own hash, and extracts it. It does not install the package and
// does not run a lifecycle script — extraction is not execution.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { findPresetDeclarations } from "./presets.mjs";
import { run } from "./proc.mjs";
import { resolveNpmPackage } from "./npm-source.mjs";

/**
 * Download, verify and extract one exact npm version.
 *
 * @returns {{root, meta, presets: {path: string, digest: string}[]}}
 */
export async function captureNpmSource({ name, version, registry, root, env, fetchImpl = fetch }) {
  const meta = await resolveNpmPackage({ name, version, registry, fetchImpl });

  const response = await fetchImpl(meta.tarball);
  if (!response.ok) {
    throw WardrobeError.from("npm tarball could not be fetched", [
      new WardrobeDiagnostic({ path: "/source", reason: `${meta.tarball} returned ${response.status}` }),
    ]);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== meta.integrity) {
    throw WardrobeError.from("npm tarball integrity does not match the registry", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: `expected ${meta.integrity.slice(0, 24)}…, got ${actual.slice(0, 24)}…`,
        hint: "nothing was extracted",
      }),
    ]);
  }

  mkdirSync(root, { recursive: true });
  const archive = join(root, `${name.replace(/[@/]/g, "-")}-${version}.tgz`);
  writeFileSync(archive, bytes);

  const extracted = await run(
    "tar",
    ["-xzf", archive, "-C", root, "--strip-components", "1"],
    { env }
  );
  if (extracted.code !== 0) {
    throw WardrobeError.from("npm tarball could not be extracted", [
      new WardrobeDiagnostic({
        path: "/source",
        reason: extracted.stderr || `tar exited ${extracted.code}`,
      }),
    ]);
  }
  rmSync(archive, { force: true });

  return { root, meta, presets: findPresetDeclarations(root) };
}
