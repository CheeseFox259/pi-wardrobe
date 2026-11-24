import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DefaultPackageManager, getAgentDir, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { coordinateCcstyle } from './ccstyle-bridge.mjs';

// Load the approved, unmodified npm package through a cooperating API view.
export default async function ccstyle(pi: ExtensionAPI) {
  const manager = new DefaultPackageManager({cwd:process.cwd(),agentDir:getAgentDir(),settingsManager:SettingsManager.inMemory()});
  const root = manager.getInstalledPath('npm:pi-cc-extensions@0.9.12','user');
  if (!root || !existsSync(join(root,'package.json')) || JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version !== '0.9.12') {
    throw new Error('Perfect Pi requires the approved pi-cc-extensions@0.9.12 package');
  }
  const { default: register } = await import(pathToFileURL(join(root,'extensions/index.ts')).href);
  register(coordinateCcstyle(pi));
}
