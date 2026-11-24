import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const reviewedPiVersion = '1.3.0';

export function adaptMaintenance(destination) {
  cpSync(new URL('./perfect-pi-adaptations/wardrobe-maintenance.md', import.meta.url), join(destination, 'docs/wardrobe-maintenance.md'));
  const path = join(destination, 'habits.test.mjs'), text = readFileSync(path, 'utf8');
  const marker = '// ── setup.mjs and doctor.mjs integration ──';
  if (!text.includes(marker)) throw new Error('Perfect Pi habits setup-test contract changed');
  writeFileSync(path, text.slice(0, text.indexOf(marker)) + readFileSync(new URL('./perfect-pi-adaptations/habits-setup-tests.txt', import.meta.url), 'utf8'));
  const compatibility = join(destination, 'docs/pi-compatibility.md');
  const note = `> Wardrobe reviewed baseline: Pi ${reviewedPiVersion}. Runtime/extension installation uses native \`pi update\`; source maintenance follows \`docs/wardrobe-maintenance.md\`. The native manager, all enabled Full extensions, skill discovery and the composer widget were exercised in isolated Pi 1.3.0 fixtures. No account model requests were made. Earlier version sections below are historical.\n\n`;
  writeFileSync(compatibility, note + readFileSync(compatibility, 'utf8').replace(/^> Wardrobe reviewed baseline:.*\n\n/, ''));
}
