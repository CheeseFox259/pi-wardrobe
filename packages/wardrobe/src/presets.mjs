// Locating preset definitions in a captured source.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PRESET_FILE = "preset.json";
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Every `preset.json` under a captured root, in a stable order.
 *
 * The tree is walked rather than probed at a fixed depth: a repository may hold
 * `presets/<name>/preset.json`, and a one-level rule would silently hide those.
 */
export function findPresetDeclarations(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.name === PRESET_FILE) {
        found.push({ path: relative, digest: digestOf(readFileSync(join(dir, entry.name))) });
      }
    }
  };
  walk(root, "");
  return found;
}

function digestOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export { PRESET_FILE };
