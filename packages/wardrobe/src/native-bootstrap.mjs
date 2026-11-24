import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managerEntry } from './native-store.mjs';
import { checkNativeOwnership } from './native-ownership.mjs';
import { checkPreparedProfile, currentPiCli } from './native-runtime.mjs';
import { prepareDeviceBindings } from './native-bindings.mjs';

export function nativeSessionDir(nativeDir, cwd) {
  return join(nativeDir, 'sessions', '--' + resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--');
}

export async function profileInvocation(store, profile, { args = process.argv.slice(2), cwd = process.cwd(), sessionFile = null, newSession = false } = {}) {
  if (!existsSync(join(profile.agentDir, 'settings.json'))) throw new Error('Preset resources are missing; restore the preset from /wardrobe: ' + profile.id);
  const bindings = prepareDeviceBindings(store, profile);
  const cli = currentPiCli();
  let clean = [...args];
  if (newSession || sessionFile) {
    const { parseArgs } = await import(pathToFileURL(join(dirname(cli), 'cli/args.js')).href);
    const parsed = parseArgs(args);
    clean = [];
    const values = { provider: '--provider', model: '--model', apiKey: '--api-key', thinking: '--thinking', mode: '--mode', sessionDir: '--session-dir', useTheme: '--use-theme', tuiMode: '--tui-mode', systemPrompt: '--system-prompt' };
    for (const [key, flag] of Object.entries(values)) if (parsed[key] !== undefined) clean.push(flag, parsed[key]);
    for (const [key, flag] of Object.entries({ extensions: '-e', skills: '--skill', promptTemplates: '--prompt-template', themes: '--theme', appendSystemPrompt: '--append-system-prompt' })) for (const value of parsed[key] ?? []) clean.push(flag, value);
    for (const [key, flag] of Object.entries({ tools: '--tools', excludeTools: '--exclude-tools', models: '--models' })) if (parsed[key]?.length) clean.push(flag, parsed[key].join(','));
    for (const [key, flag] of Object.entries({ offline: '--offline', noSession: '--no-session', noSkills: '--no-skills', noExtensions: '--no-extensions', noMcp: '--no-mcp', noPromptTemplates: '--no-prompt-templates', noThemes: '--no-themes', noContextFiles: '--no-context-files', noTools: '--no-tools', noBuiltinTools: '--no-builtin-tools', verbose: '--verbose' })) if (parsed[key]) clean.push(flag);
    if (parsed.projectTrustOverride !== undefined) clean.push(parsed.projectTrustOverride ? '--approve' : '--no-approve');
    for (const [key, value] of parsed.unknownFlags) { clean.push('--' + key); if (typeof value === 'string') clean.push(value); }
  }
  if (!clean.some(arg => arg === '--session-dir' || arg.startsWith('--session-dir='))) clean.push('--session-dir', process.env.PI_CODING_AGENT_SESSION_DIR || nativeSessionDir(store.nativeDir, cwd));
  if (sessionFile) clean.push('--session', sessionFile);
  if (!clean.includes(managerEntry)) clean.push('-e', managerEntry);
  clean.push(...bindings.args);
  const bridge = '--import=' + pathToFileURL(join(import.meta.dirname, 'native-config.mjs')).href;
  const options = (process.env.NODE_OPTIONS || '').replace(/(?:^|\s)--import=(?:"[^"]*\/native-config\.mjs"|[^\s]*\/native-config\.mjs)(?=\s|$)/g, '').trim();
  return { file: process.execPath, args: [process.execPath, cli, ...clean], env: { ...process.env, ...bindings.env,
    PI_CODING_AGENT_DIR: profile.agentDir, WARDROBE_NATIVE_AGENT_DIR: store.nativeDir,
    WARDROBE_NATIVE_PROFILE: profile.id, WARDROBE_NATIVE_REVISION_ROOT: dirname(profile.agentDir),
    WARDROBE_AGENT_DIR: store.nativeDir, WARDROBE_PI_CLI: cli,
    NODE_OPTIONS: [options, bridge].filter(Boolean).join(' '),
  } };
}

export function executeProfile(invocation) {
  if (typeof process.execve !== 'function') throw new Error('This Pi/Node installation cannot replace the process automatically; Node 22.19+ on macOS/Linux is required.');
  process.execve(invocation.file, invocation.args, invocation.env);
}

export async function bootstrapNative(store) {
  if (process.env.WARDROBE_NATIVE_PROFILE && resolve(process.env.PI_CODING_AGENT_DIR || '.') === store.read().profiles[process.env.WARDROBE_NATIVE_PROFILE]?.agentDir) return;
  const config = store.read();
  if (!Object.keys(config.profiles).length) return;
  // Pi resolves file paths, ID prefixes, continue and its interactive picker
  // before session_start. Use that actual selection, without opening a picker
  // twice or guessing which transcript it will resolve to.
  if (process.argv.slice(2).some(arg => ['--session', '--continue', '-c', '--resume', '-r', '--fork'].includes(arg) || arg.startsWith('--session='))) return { restoreSession: true };
  const profile = store.select(process.cwd());
  if (profile) { checkPreparedProfile(profile); checkNativeOwnership(store, profile); executeProfile(await profileInvocation(store, profile)); }
}
