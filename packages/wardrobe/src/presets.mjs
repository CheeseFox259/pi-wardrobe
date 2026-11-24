// Locating preset definitions in a captured source.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
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
  const manifest = join(root, 'package.json');
  const index = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).wardrobe?.presets : undefined;
  if (index !== undefined) {
    if (!Array.isArray(index) || !index.length || new Set(index).size !== index.length) throw new Error('wardrobe.presets must be a non-empty array of unique preset paths');
    return index.map(path => {
      if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..') || path.split('/').at(-1) !== PRESET_FILE) throw new Error('Unsafe wardrobe.presets path: ' + path);
      let current = root;
      for (const part of path.split('/')) {
        current = join(current, part);
        const info = lstatSync(current, { throwIfNoEntry: false });
        if (!info || info.isSymbolicLink()) throw new Error('Missing or symlinked wardrobe.presets path: ' + path);
      }
      return { path, digest: digestOf(readFileSync(current)) };
    });
  }
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
