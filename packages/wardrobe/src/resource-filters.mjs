import { lstatSync } from 'node:fs';
import { join } from 'node:path';

// Pi filters match discovered files. A selected directory means its exported
// descendants, never arbitrary helpers or resources absent from package exports.
export function nativeResourceFilters(root, selected = []) {
  return selected.map(path => root && lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory()
    ? path.replace(/\/+$/, '') + '/**' : path).sort();
}
