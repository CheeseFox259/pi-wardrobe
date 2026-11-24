#!/usr/bin/env node
// A short, explicit entry point over Wardrobe's existing review/install/launch APIs.
import { existsSync, readFileSync, lstatSync, mkdirSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { runCommand } from '../packages/wardrobe/src/commands.mjs';
import { runRevision } from '../packages/wardrobe/src/launch.mjs';
import { renderResult } from '../packages/wardrobe/src/render.mjs';
import { detectPiRuntime } from '../presets/perfect-pi/scripts/pi-runtime.mjs';
import { serveLocalSource } from './serve-local-source.mjs';

const workspace = resolve(import.meta.dirname, '..');
const PRESET = 'presets/perfect-pi/preset.json';
const statePath = managerDir => join(managerDir, 'wardrobe/perfect-pi.json');

function assertRegular(path) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`拒绝写入非普通文件：${path}`);
}

function writeAtomic(path, text, mode = 0o600) {
  assertRegular(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID();
  try { writeFileSync(temporary, text, { flag: 'wx', mode }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

function readState(managerDir) {
  const path = statePath(managerDir);
  if (!existsSync(path)) return null;
  assertRegular(path);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.schemaVersion !== 1 || !/^[a-f0-9]{16}$/.test(state.revision) || !['cli', 'entry', 'launcher', 'sourceWorkspace'].every(key => typeof state[key] === 'string')) throw new Error('Perfect Pi 安装记录无效；请使用原始 Wardrobe doctor 检查。');
  return state;
}

function launcherText(managerDir) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const bootstrap = "import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url'; const state=JSON.parse(readFileSync(process.argv[1],'utf8')); const {main}=await import(pathToFileURL(state.entry).href); process.exitCode=await main(process.argv.slice(2));";
  return `#!/bin/sh\n# PI_WARDROBE_PERFECT_PI ${Buffer.from(managerDir).toString('base64')}\nexport WARDROBE_AGENT_DIR=${quote(managerDir)}\nexec ${quote(process.execPath)} --input-type=module -e ${quote(bootstrap)} ${quote(statePath(managerDir))} "$@"\n`;
}

function checkLauncher(path, managerDir) {
  assertRegular(path);
  if (existsSync(path) && readFileSync(path, 'utf8').split('\n')[1] !== launcherText(managerDir).split('\n')[1]) throw new Error(`已有同名程序，未覆盖：${path}；用 --bin-dir 指定其他目录。`);
}

// The stable wrapper reads one atomically replaced selection record. On a failed
// commit it still reads the old selection; only a new or repaired wrapper needs undo.
function commitEntry(managerDir, state) {
  const path = state.launcher;
  checkLauncher(path, managerDir);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const oldMode = before === null ? null : lstatSync(path).mode & 0o777;
  const text = launcherText(managerDir);
  const changed = before !== text || !(oldMode & 0o111);
  if (changed) writeAtomic(path, text, 0o755);
  try { writeAtomic(statePath(managerDir), JSON.stringify(state, null, 2) + '\n'); }
  catch (error) {
    if (changed) {
      try { if (before === null) rmSync(path, { force: true }); else writeAtomic(path, before, oldMode); }
      catch { error.message += '；入口文件恢复失败，请检查安装目录权限，原修订选择记录未切换'; }
    }
    throw error;
  }
}

function parse(argv) {
  const options = {}, args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'start';
  const childArgs = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') { childArgs.push(...args.slice(i + 1)); break; }
    if (/^--(?:config|replace)(?:=|$)/.test(token)) throw new Error('模型与认证由 Pi 管理；请直接使用现有 Pi 配置，模型选择使用 /model。');
    if (['--agent-dir', '--bin-dir', '--source', '--confirm'].includes(token)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${token} 需要一个值`);
      options[token.slice(2)] = args[++i];
    } else if (token === '--help' || token === '-h') options.help = true;
    else childArgs.push(token);
  }
  return { command, options, childArgs };
}

function nativeLaunchEnv(env, revision) {
  const home = env.HOME || homedir();
  const configured = env.PERFECT_PI_NATIVE_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(home, '.pi/agent');
  const nativeDir = configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured;
  return {...env,
    PERFECT_PI_NATIVE_AGENT_DIR: resolve(nativeDir),
    PERFECT_PI_NATIVE_REVISION_ROOT: join(env.WARDROBE_AGENT_DIR, 'wardrobe/staging', revision),
    NODE_OPTIONS: [env.NODE_OPTIONS, '--import=' + pathToFileURL(join(import.meta.dirname, 'native-pi-config.mjs')).href].filter(Boolean).join(' '),
  };
}

async function runtimeEnv(env, managerDir, state = null) {
  const home = env.HOME || homedir();
  const explicit = env.WARDROBE_PI_CLI;
  if (explicit && !existsSync(explicit)) throw new Error('指定的 Pi CLI 不存在，请检查 WARDROBE_PI_CLI');
  // The native managed current-version wins over the CLI recorded at installation.
  // Compatibility is checked against the reviewed preset by doctor/install, not a
  // second hardcoded version gate in this legacy entry.
  const nativeDir = env.PERFECT_PI_NATIVE_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(home, '.pi/agent');
  const runtime = await detectPiRuntime({
    env, agentDir: nativeDir,
    ...(explicit ? { roots: [dirname(dirname(explicit))] } : {}),
  }) || (!explicit && state?.cli && existsSync(state.cli)
    ? await detectPiRuntime({ roots: [dirname(dirname(state.cli))] }) : null);
  if (!runtime) throw new Error('未找到已安装的 Pi；可用 WARDROBE_PI_CLI 指定其 dist/cli.js。');
  return {
    ...env,
    WARDROBE_AGENT_DIR: managerDir,
    WARDROBE_PI_CLI: explicit || join(runtime.root, 'dist/cli.js'),
    PI_GLOBAL_NODE_MODULES: dirname(dirname(runtime.root)),
    WARDROBE_REGISTRY: env.WARDROBE_REGISTRY || 'https://registry.npmjs.org/',
  };
}

function checked(result) {
  if (!result.ok) throw new Error(result.result.text);
  return result.result;
}

function showPlan(plan, managerDir, stdout) {
  stdout.write(`\n安装计划：${plan.declaration.name} ${plan.declaration.version}\n`);
  stdout.write(`  来源：${plan.source.locator}\n`);
  for (const surface of plan.installationSurfaces) stdout.write(`  ${surface.resolvesTo || surface.source}${surface.installsCode ? '（运行安装脚本）' : ''}\n`);
  const counts = {};
  for (const selector of plan.resourceSelectors) counts[selector.kind] = (counts[selector.kind] || 0) + selector.loaded.length;
  stdout.write(`  资源：${JSON.stringify(counts)}\n  辅助文件：${plan.agent?.files.length || 0}\n`);
  stdout.write(`  设置：${JSON.stringify(plan.agent?.settings || {})}\n`);
  stdout.write(`  安装目录：${managerDir}\n  完整计划：${join(managerDir, 'wardrobe/plans', plan.planId + '.json')}\n  digest: ${plan.digest}\n`);
}

async function setup({ options, env, managerDir, stdin, stdout, stderr, cwd, update = false }) {
  const current = readState(managerDir);
  const scoped = await runtimeEnv(env, managerDir, current);
  if (current && !update && !options.source) {
    const health = checked(await runCommand(`doctor ${current.revision}`, { env: scoped }));
    if (health.revisions.find(item => item.revision === current.revision)?.state !== 'available') throw new Error('已有安装需要修复；运行 perfect-pi doctor 查看详情，或 perfect-pi update 安装新修订。');
    if (!existsSync(current.entry)) throw new Error('已安装的入口代码缺失；运行 perfect-pi update 审阅并安装新修订。');
    const state = { ...current, launcher: options['bin-dir'] ? join(resolve(options['bin-dir']), 'perfect-pi') : current.launcher };
    commitEntry(managerDir, state);
    stdout.write(`已有安装，通过检查。启动：${state.launcher}\n`);
    return 0;
  }
  if (!options.source && !stdin.isTTY) {
    stderr.write('请在终端运行 npm run setup；自动化安装需提供固定 --source 和对应 --confirm digest。\n');
    return 2;
  }
  const bin = resolve(options['bin-dir'] || (current ? dirname(current.launcher) : join(env.HOME || homedir(), '.local/bin')));
  const launcher = join(bin, 'perfect-pi');
  checkLauncher(launcher, managerDir);
  let local;
  try {
    if (!options.source) {
      stdout.write('正在准备当前源码快照…\n');
      local = await serveLocalSource({ workspaceDir: current?.sourceWorkspace || workspace, outputDir: join(managerDir, 'wardrobe/source-snapshots') });
    }
    const request = `install ${options.source || local.source} --preset ${PRESET}`;
    stdout.write('正在检查 Perfect Pi 来源与依赖…\n');
    const reviewed = checked(await runCommand(request, { env: scoped }));
    if (reviewed.plan.identity.id !== 'perfect-pi/full') throw new Error('来源不是 perfect-pi/full；请使用原始 Wardrobe 安装其他预设。');
    showPlan(reviewed.plan, managerDir, stdout);
    if (options.confirm !== reviewed.plan.digest) {
      if (options.confirm) throw new Error('确认 digest 与当前计划不一致；没有安装任何包。');
      if (!stdin.isTTY) {
        stderr.write('尚未安装。审阅后使用 --confirm 加上方完整 digest 重新运行。\n');
        return 2;
      }
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        let answer = await prompt.question('按此计划安装并检查启动？[y/N，d 查看详细计划] ');
        if (answer.trim().toLowerCase() === 'd') {
          stdout.write(renderResult(reviewed) + '\n');
          answer = await prompt.question('按此计划安装并检查启动？[y/N] ');
        }
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) { stdout.write('已取消安装。\n'); return 0; }
      } finally { prompt.close(); }
    }
    stdout.write('正在安装固定依赖，首次下载可能需要几分钟…\n');
    const installed = checked(await runCommand(`${request} --confirm ${reviewed.plan.digest}`, { env: scoped }));
    if (installed.state !== 'available') throw new Error(`安装未完成：${installed.state}`);
    stdout.write('正在执行离线启动检查…\n');
    const launched = await runRevision({ agentDir: managerDir, selector: installed.staging.revision, env: nativeLaunchEnv(scoped, installed.staging.revision), cwd, args: ['--offline', '--version'], stdio: 'ignore' });
    if (launched.exitCode !== 0) throw new Error('离线启动检查失败；运行 Wardrobe doctor 查看该修订。');
    const ownPackage = installed.staging.installed.find(item => item.alias === 'self');
    const script = join(ownPackage.installedRelative ? join(installed.staging.agentDir, ownPackage.installedRelative) : ownPackage.installedPath, 'scripts/perfect-pi.mjs');
    if (!existsSync(script)) throw new Error('来源缺少 Perfect Pi 启动入口，未切换当前安装。');
    const state = { schemaVersion: 1, revision: installed.staging.revision, cli: scoped.WARDROBE_PI_CLI, entry: script, launcher, sourceWorkspace: current?.sourceWorkspace || workspace };
    commitEntry(managerDir, state);
    stdout.write(`\n安装完成，离线启动检查通过。\n启动：${launcher}\n检查：${launcher} doctor\n`);
    if (!(env.PATH || '').split(':').includes(bin)) stdout.write(`若要直接输入 perfect-pi，将 ${bin} 加入 PATH；当前也可直接用上面的绝对路径，或 npm start。\n`);
    stdout.write('旧 CBM 会话仍在运行时，可先通过 /mcp 禁用本修订的 codebase-memory；缓存切换步骤见中文指南。\n');
    return 0;
  } finally {
    if (local) {
      await new Promise(done => local.server.close(done));
      rmSync(local.snapshot, { recursive: true, force: true });
    }
  }
}

export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  try {
    const { command, options, childArgs } = parse(argv);
    if (options.help) {
      stdout.write('Perfect Pi\n  setup             安装或检查当前安装\n  start [-- Pi参数]  在当前项目启动（默认）\n  doctor            检查当前安装\n  update            审阅并安装当前源码的新修订\n');
      return 0;
    }
    const managerDir = resolve(options['agent-dir'] || env.WARDROBE_AGENT_DIR || join(env.HOME || homedir(), '.pi/wardrobe-perfect-pi'));
    if (command === 'setup' || command === 'update') return await setup({ options, env, managerDir, stdin, stdout, stderr, cwd, update: command === 'update' });
    if (command === 'config') throw new Error('模型与认证由 Pi 管理；请直接使用现有 Pi 配置，模型选择使用 /model。');
    if (!['start', 'doctor', 'status'].includes(command)) throw new Error(`未知命令 ${command}；运行 perfect-pi --help 查看用法。`);
    const state = readState(managerDir);
    if (!state) throw new Error('尚未安装 Perfect Pi；请在源码目录运行 npm run setup。');
    const scoped = await runtimeEnv(env, managerDir, state);
    if (command === 'doctor' || command === 'status') {
      const result = checked(await runCommand(`${command} ${state.revision}`, { env: scoped }));
      stdout.write(renderResult(result) + '\n');
      return result.revisions.find(item => item.revision === state.revision)?.state === 'available' ? 0 : 1;
    }
    const result = await runRevision({ agentDir: managerDir, selector: state.revision, env: nativeLaunchEnv(scoped, state.revision), cwd, args: childArgs });
    for (const item of result.diagnostics) if (item.path === '/launch/externalResources') stderr.write(`perfect-pi: ${item.reason}\n`);
    const unverified = result.diagnostics.filter(item => item.path !== '/launch/externalResources');
    if (unverified.length) stderr.write(`perfect-pi: ${unverified.length} 项能力无法由命令接口核实，详情：${join(managerDir, 'wardrobe/runs', result.runId + '.json')}\n`);
    return result.exitCode ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
  } catch (error) { stderr.write(`perfect-pi: ${error.message}\n`); return 1; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
