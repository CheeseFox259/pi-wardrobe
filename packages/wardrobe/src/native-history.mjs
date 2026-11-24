import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './native-store.mjs';

import { holdNativeProfile } from './native-ownership.mjs';

// Session headers are public metadata; never read a whole conversation to select resources.
export function sessionProfile(store, file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(8192), count = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, count).toString('utf8').split('\n', 1)[0];
    const header = JSON.parse(line);
    if (header.type !== 'session' || !/^[a-zA-Z0-9._-]+$/.test(header.id)) return null;
    return readJson(join(store.root, 'sessions', header.id + '.json'))?.profile ?? null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function recordNativeSession(pi, ctx, store) {
  const config = store.read(), id = process.env.WARDROBE_NATIVE_PROFILE || (config.initialized ? 'original' : null);
  const profile = config.profiles[id];
  if (!profile) return;
  holdNativeProfile(store, profile);
  const sessionId = ctx.sessionManager.getSessionId();
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error('Invalid Pi session ID');
  writeJson(join(store.root, 'sessions', sessionId + '.json'), { sessionId, profile: id, sessionFile: ctx.sessionManager.getSessionFile() ?? null, cwd: ctx.cwd, name: pi.getSessionName?.() ?? null });
  const last = ctx.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'wardrobe.preset').at(-1);
  if (last?.data?.profile !== id) pi.appendEntry('wardrobe.preset', { profile: id, revision: profile.revision ?? null });
  ctx.ui.setStatus?.('wardrobe', undefined);
  ctx.ui.setWidget?.('wardrobe', ['Preset: ' + profile.name], { placement: 'aboveEditor' });
  pi.events?.emit('wardrobe:preset', { profile: { id: profile.id, name: profile.name, version: profile.version }, ui: ctx.ui });
}
