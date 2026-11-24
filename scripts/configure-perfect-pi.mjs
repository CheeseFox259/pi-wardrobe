#!/usr/bin/env node
// Model configuration is owned by Pi; this retired entry never reads or copies it.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function configurePerfectPi() {
  throw new Error('Model configuration belongs to Pi. Use Pi native configuration, /login and /model; Wardrobe no longer copies models.json.');
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.stderr.write('Model configuration belongs to Pi. Use /login and /model in Pi.\n');
  process.exitCode = 1;
}
