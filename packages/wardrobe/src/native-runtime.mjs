// Runtime and cache checks used before the native process handoff. Keep the
// installer, authoring and manager command graph out of this startup path.
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { supportsPi } from './semver.mjs';
import { readJson, writeJson } from './native-store.mjs';

export function resourceConfiguration(agentDir) { const settings = readJson(join(agentDir, 'settings.json')); return Object.fromEntries(['packages', 'extensions', 'skills', 'prompts', 'themes'].filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]])); }

export function currentPiCli() {
  const cli = process.env.WARDROBE_PI_CLI || process.argv[1];
  if (!cli || !existsSync(cli)) throw new Error('Pi 可执行文件缺失');
  const entry = realpathSync(cli);
  let root = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    if (readJson(join(root, 'package.json'))?.name === '@earendil-works/pi-coding-agent') {
      // The configuration bridge patches importable core modules. Use the
      // matching modular entry from this release, including when native Pi
      // starts through dist/bundle/cli.js with its separate bundled classes.
      const modular = join(root, 'dist/cli.js');
      if (!existsSync(modular)) throw new Error('当前 Pi 安装缺少 preset 所需的模块入口');
      return modular;
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  throw new Error('无法定位当前 Pi 安装目录');
}

export function currentPiVersion() { return readJson(join(dirname(currentPiCli()), '..', 'package.json'))?.version ?? null; }

export function checkPreparedProfile(profile) {
  if (!profile?.agentDir || !existsSync(join(profile.agentDir, 'settings.json'))) throw new Error('Preset 资源缺失；请在 /wardrobe 中恢复或重新安装。');
  const pi = currentPiVersion();
  if (!pi) throw new Error('无法识别当前 Pi 版本');
  if (profile.compatibility?.pi && supportsPi(profile.compatibility.pi, pi) !== true) throw new Error('Preset 与当前 Pi ' + pi + ' 不兼容：' + profile.name + ' ' + profile.compatibility.pi);
  if (profile.cache) {
    const cache = readJson(profile.cache);
    if (!cache || cache.node !== process.version || cache.platform !== process.platform) throw new Error('Pi/Node 运行环境已变化；请先运行 /wardrobe verify ' + profile.id);
    if (JSON.stringify(cache.configuration) !== JSON.stringify(resourceConfiguration(profile.agentDir))) throw new Error('Preset 的资源声明发生变化，请运行 /wardrobe verify ' + profile.id);
    for (const [relative, size, mtimeMs, ctimeMs, mode, link] of cache.stamps) {
      const info = lstatSync(join(profile.agentDir, relative), { throwIfNoEntry: false });
      if (!info || info.size !== size || info.mtimeMs !== mtimeMs || info.ctimeMs !== ctimeMs || info.mode !== mode || (info.isSymbolicLink() ? readlinkSync(join(profile.agentDir, relative)) : null) !== link) throw new Error('Preset 代码发生变化；请运行 /wardrobe verify ' + profile.id + '：' + relative);
    }
    if(cache.pi!==pi){cache.previousPi=cache.pi;cache.pi=pi;writeJson(profile.cache,cache);}
  }
}
