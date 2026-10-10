// Local preset discovery and the owned snapshot store.
//
// Discovery reads a declared source directory and validates each `preset.json`.
// Inspecting a preset captures its declaration into a store this manager owns.
// A snapshot is data this manager wrote; it is not an installed revision and
// never claims to be active.
//
// Nothing here reads or writes the user's settings, auth or package installs.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { WardrobeError } from "./diagnostics.mjs";
import { validateDefinition } from "./schema.mjs";

const PRESET_FILE = "preset.json";

/** Where local presets are looked for when nothing else is configured. */
function defaultSourceDir(agentDir) {
  return join(agentDir, "presets");
}

/** Source directories to scan, most explicit first. */
export function sourceDirs(agentDir, env = process.env) {
  const configured = env.WARDROBE_PRESET_DIRS;
  if (configured) {
    return configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(entry));
  }
  return [defaultSourceDir(agentDir)];
}

export class PresetStore {
  constructor(agentDir) {
    this.agentDir = agentDir;
    this.root = join(agentDir, "wardrobe", "snapshots");
  }

  /** Snapshot directory for an identity; a hash keeps ids filesystem-safe. */
  #dirFor({ source, id }) {
    const key = createHash("sha256").update(`${source}#${id}`).digest("hex").slice(0, 32);
    return join(this.root, key);
  }

  /**
   * Capture a preset definition.
   *
   * Only the definition is captured. Resource selectors name paths *inside*
   * declared packages, which are not present until the package is installed, so
   * materialising them here would mean inventing a layout the contract does not
   * define. The declaration is recorded verbatim for the install step to use.
   */
  write(preset, definition) {
    const dir = this.#dirFor(preset);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`);
    writeFileSync(
      join(dir, "meta.json"),
      `${JSON.stringify(
        {
          source: preset.source,
          id: preset.id,
          capturedFrom: preset.capturedFrom,
          capturedAt: new Date().toISOString(),
          declaredResources: (definition.resources ?? []).length,
        },
        null,
        2
      )}\n`
    );
    return dir;
  }

  /** An existing snapshot for an identity, or null when none was captured. */
  snapshotOf({ source, id }) {
    const metaPath = join(this.#dirFor({ source, id }), "meta.json");
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return {
      capturedAt: meta.capturedAt,
      capturedFrom: meta.capturedFrom,
      declaredResources: meta.declaredResources ?? 0,
    };
  }
}

/**
 * Scan source directories for preset declarations.
 *
 * @returns {{presets: object[], rejected: WardrobeError[]}}
 */
export function discover(dirs) {
  const presets = [];
  const rejected = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const declarationPath of findDeclarations(dir)) {
      const source = dir;
      let raw;
      try {
        raw = JSON.parse(readFileSync(declarationPath, "utf8"));
      } catch (error) {
        rejected.push(
          WardrobeError.from(`${declarationPath} is not readable JSON`, [
            new WardrobeDiagnostic({
              path: "",
              reason: error instanceof Error ? error.message : String(error),
            }),
          ])
        );
        continue;
      }
      const result = validateDefinition(raw, { origin: declarationPath });
      if (!result.ok) {
        rejected.push(result.error);
        continue;
      }
      const preset = {
        source,
        id: result.definition.id,
        name: result.definition.name,
        version: result.definition.version,
        definition: result.definition,
        // Captured presets carry `path` relative to their root and the digest
        // of the declaration; a locally discovered one is presented the same
        // way so composition never has to know which it was given.
        path: relative(source, declarationPath),
        digest: digestOf(raw),
        declarationPath,
        capturedFrom: declarationPath,
      };
      presets.push(preset);
    }
  }
  return { presets, rejected };
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

function digestOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Every `preset.json` under a source root.
 *
 * The tree is walked rather than probed at a fixed depth: a repository may hold
 * `presets/<name>/preset.json`, and a one-level rule would silently hide those.
 */
function findDeclarations(root) {
  const found = [];
  const walk = (dir) => {
    const direct = join(dir, PRESET_FILE);
    if (existsSync(direct)) found.push(direct);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    }
  };
  walk(root);
  return found;
}
