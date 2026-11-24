import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentPiCli } from './native-service.mjs';
import { addProfileResources, createDraft, draftFromProfile, draftRecord, editDraft, readDraft, saveDraft } from './native-authoring.mjs';
import { bindDevice, deviceValues } from './native-bindings.mjs';
import { projectKey, readJson } from './native-store.mjs';

export const presetKey = p => p.presetKey || (p.id === 'original' ? 'local/original' : (p.source?.locator || p.id) + '#' + (p.source?.id || p.name));
export function presetRoster(store) {
  const groups = new Map();
  for (const profile of Object.values(store.read().profiles)) {
    const key = presetKey(profile), revisions = groups.get(key) || [];
    revisions.push(profile); groups.set(key, revisions);
  }
  return [...groups].map(([key, revisions]) => ({ key, revisions, profile: revisions.at(-1) }));
}
const safeText = value => String(value).replace(/[\x00-\x1f\x7f]/g, '');

/** Real searchable TUI. Actions stay in the key bar, never masquerade as presets. */
export async function choosePreset(ctx, store, selectedId = process.env.WARDROBE_NATIVE_PROFILE || 'original') {
  const roster = presetRoster(store), config = store.read(), active = process.env.WARDROBE_NATIVE_PROFILE || 'original';
  const badge = item => [item.revisions.some(p => p.id === active) && '当前', item.revisions.some(p => p.id === config.default) && '全局默认', item.revisions.some(p => p.id === config.projects[projectKey(ctx.cwd)]) && '项目默认'].filter(Boolean).join(' · ');
  if (!ctx.ui.custom || ctx.hasUI === false) {
    const labels = roster.map((item, i) => item.profile.name + (badge(item) ? ' · ' + badge(item) : '') + (roster.some((other, j) => j !== i && other.profile.name === item.profile.name) ? ' · ' + item.profile.id : ''));
    const choice = await ctx.ui.select('Wardrobe', [...labels, '创建', '导入', '草稿', '恢复对话']);
    return labels.includes(choice) ? { action: 'use', profile: roster[labels.indexOf(choice)].profile } : choice ? { action: { 创建: 'create', 导入: 'import', 草稿: 'drafts', 恢复对话: 'resume' }[choice] } : null;
  }
  const toolkit = await import(pathToFileURL(createRequire(currentPiCli()).resolve('@earendil-works/pi-tui')).href);
  const { Input, Key, matchesKey, truncateToWidth } = toolkit;
  return ctx.ui.custom((tui, theme, _keys, done) => {
    const input = new Input(); let cursor = Math.max(0, roster.findIndex(item => item.revisions.some(p => p.id === selectedId)));
    const filtered = () => roster.filter(item => (item.profile.name + ' ' + item.profile.id + ' ' + (item.profile.source?.locator || '')).toLowerCase().includes(input.getValue().toLowerCase()));
    const finish = action => { const selected = filtered()[cursor]; if (selected) done({ action, profile: selected.profile }); };
    return {
      render(width) {
        const items = filtered(), count = Math.max(3, Math.min(12, (tui.terminal?.rows || 30) - 9)), start = Math.max(0, cursor - count + 1);
        const rows = [theme.fg('accent', 'Wardrobe'), ...input.render(Math.max(1, width - 5)).map(line => '搜索 ' + line), ''];
        for (const [index, item] of items.slice(start, start + count).entries()) {
          const duplicate = roster.some(other => other.key !== item.key && other.profile.name === item.profile.name);
          const line = (start + index === cursor ? '❯ ' : '  ') + (duplicate ? '[' + item.profile.id.slice(-8) + '] ' : '') + safeText(item.profile.name) + (badge(item) ? '  ' + badge(item) : '');
          rows.push(truncateToWidth(start + index === cursor ? theme.fg('accent', line) : line, width));
        }
        if (!items.length) rows.push(theme.fg('dim', '没有匹配的预设'));
        rows.push('', truncateToWidth('Enter 使用  → 管理  Ctrl+n 创建  Ctrl+o 导入', width), truncateToWidth('Ctrl+d 草稿  Ctrl+r 对话  Esc 关闭', width));
        return rows;
      },
      handleInput(data) {
        if (matchesKey(data, Key.escape)) return done(null);
        if (matchesKey(data, Key.ctrl('n'))) return done({ action: 'create' });
        if (matchesKey(data, Key.ctrl('o'))) return done({ action: 'import' });
        if (matchesKey(data, Key.ctrl('d'))) return done({ action: 'drafts' });
        if (matchesKey(data, Key.ctrl('r'))) return done({ action: 'resume' });
        if (matchesKey(data, Key.enter)) return finish('use');
        if (matchesKey(data, Key.right)) return finish('manage');
        const items = filtered();
        if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
        else if (matchesKey(data, Key.down)) cursor = Math.min(Math.max(0, items.length - 1), cursor + 1);
        else { input.handleInput(data); cursor = 0; }
        tui.requestRender();
      }, invalidate() { input.invalidate?.(); },
    };
  });
}

export async function chooseProfile(ctx, store, title = '选择预设') {
  const items = presetRoster(store), labels = items.map((item, i) => item.profile.name + (items.some((other, j) => j !== i && other.profile.name === item.profile.name) ? ' · ' + item.profile.id : ''));
  const label = await ctx.ui.select(title, labels); return label ? items[labels.indexOf(label)].profile : null;
}

export async function createPresetPanel(pi, ctx, store) {
  const choices = ['从当前环境', '从已有预设', '从空白创建', '让 Pi 创建'];
  const choice = await ctx.ui.select('创建预设', choices); if (!choice) return;
  let profile;
  if (choice === choices[0]) profile = store.read().profiles[process.env.WARDROBE_NATIVE_PROFILE || 'original'];
  if (choice === choices[1]) { profile = await chooseProfile(ctx, store); if (!profile) return; }
  const name = await ctx.ui.input('预设名称', profile ? profile.name + ' 副本' : '新预设'); if (!name?.trim()) return;
  const draft = profile ? await draftFromProfile(store, profile, { copy: true, name }) : createDraft(store, { name });
  if (choice === choices[3]) return askPiForDraft(pi, ctx, store, draft.id);
  return editPresetPanel(pi, ctx, store, draft.id);
}

export async function askPiForDraft(pi, ctx, store, id) {
  if (!ctx.isIdle() || ctx.isCompacting?.()) throw new Error('请等待当前任务完成');
  const draft = draftRecord(store, id);
  if(draft.saved)throw new Error('草稿已保存，请从已保存的预设创建编辑草稿');
  const request = await ctx.ui.input('让 Pi 如何修改这个预设？', '');
  if (!request?.trim()) return;
  const task = join(store.root, 'drafts', id, 'TASK.md');
  writeFileSync(task, [
    '# Wardrobe preset draft', `User request: ${JSON.stringify(request)}`,
    `Edit only the public source at ${JSON.stringify(draft.source)}. Read preset.json and package.json first.`,
    'Use the existing Pi resource format. Preserve custom skills and companions. Keep model/auth settings and project configuration owned by Pi. Record machine-specific requirements in package.json wardrobe.deviceBindings without binding values. Do not modify installed revisions or global settings, run setup scripts, publish, or activate this draft.',
    `When complete, tell the user to open /wardrobe draft ${id} for review. Saving goes through the same fixed snapshot, resource validation and explicit review as manual editing. Do not run save --yes or use commands on the user’s behalf.`,
  ].join('\n\n') + '\n', { mode: 0o600 });
  const message = `创建或编辑预设。先读取 ${JSON.stringify(task)}，按其中请求修改草稿；完成后交回用户审阅。`;
  let replaced = false;
  const next = await ctx.newSession({ withSession: async replacement => {
    replaced = true;
    replacement.ui.notify('Pi 编辑草稿中', 'info');
    await replacement.sendUserMessage(message);
  } });
  if (next?.cancelled) return;
  // Older Pi releases keep the command context alive and ignore withSession.
  if (!replaced) { pi.sendUserMessage(message); ctx.ui.notify('Pi 编辑草稿中', 'info'); }
  return 'model';
}

export async function editPresetPanel(pi, ctx, store, id) {
  for (;;) {
    const draft = readDraft(store, id), resources = draft.definition.resources.flatMap(r => r.include || []);
    if(draft.saved)throw new Error('草稿已保存，请从已保存的预设创建编辑草稿');
    const choice = await ctx.ui.select(draft.definition.name + ' · 草稿', ['名称', '资源 · ' + resources.length, '添加资源', '偏好', '设备需求', '让 Pi 编辑', '审阅并保存']);
    if (!choice) return;
    if (choice === '名称') { const name = await ctx.ui.input('名称', draft.definition.name); if (name?.trim()) editDraft(store, id, { name }); }
    else if (choice.startsWith('资源 ·')) {
      for (;;) {
        const current = readDraft(store, id);
        const labels = current.available.map(item => (current.definition.resources[item.selector]?.include?.includes(item.path) ? '✓ ' : '○ ') + item.kind + ' · ' + item.path);
        const selected = await ctx.ui.select('资源', labels); if (!selected) break;
        editDraft(store, id, { resource: labels.indexOf(selected) });
      }
    } else if (choice === '添加资源') {
      const profile = await chooseProfile(ctx, store, '从预设添加资源'); if (profile) await addProfileResources(store, id, profile);
    } else if (choice === '偏好') {
      await preferencesPanel(ctx, store, id);
    } else if (choice === '设备需求') {
      await requirementsPanel(ctx, store, id);
    } else if (choice === '让 Pi 编辑') return askPiForDraft(pi, ctx, store, id);
    else if (choice === '审阅并保存') {
      const profile = await saveDraft(store, id, { confirm: plan => ctx.ui.confirm('保存 ' + plan.declaration.name, `${plan.declaration.version}\n资源 ${plan.resourceSelectors.reduce((n, r) => n + r.loaded.length, 0)}\n设备需求 ${plan.agent?.deviceBindings?.length || 0}`) });
      if (profile) { ctx.ui.notify('已保存 ' + profile.name, 'info'); return profile; }
    }
  }
}

async function preferencesPanel(ctx, store, id) {
  const draft = readDraft(store, id), preferences = { ...draft.preferences };
  const choice = await ctx.ui.select('偏好', ['主题', '界面', '启动显示', '技能命令', '默认工具', '上下文压缩']);
  if (choice === '主题') {
    const themes = draft.definition.resources.filter(r => r.kind === 'themes').flatMap(r => r.include || []).filter(path => !/[?*\[]/.test(path)).map(path => basename(path, '.json'));
    const theme = await ctx.ui.select('主题', [...new Set(['dark', 'light', ...themes])]); if (theme) preferences.theme = theme;
  } else if (choice === '界面') {
    const mode = await ctx.ui.select('界面', ['全屏', '常规']); if (mode) preferences.tuiMode = mode === '全屏' ? 'fullscreen' : 'regular';
  } else if (choice === '启动显示') {
    const value = await ctx.ui.select('启动显示', ['标准', '标题', '安静']); if (value) preferences.quietStartup = { 标准: false, 标题: 'header', 安静: true }[value];
  } else if (choice === '技能命令') {
    const value = await ctx.ui.select('技能命令', ['开启', '关闭']); if (value) preferences.enableSkillCommands = value === '开启';
  } else if (choice === '默认工具') {
    const value = await ctx.ui.input('默认工具 · 逗号分隔', (preferences.defaultTools || []).join(','));
    if (value !== undefined) preferences.defaultTools = value.split(',').map(value => value.trim()).filter(Boolean);
  } else if (choice === '上下文压缩') {
    const field = await ctx.ui.select('上下文压缩', ['开关', '保留 token', '近期 token']);
    if (field) {
      preferences.compaction = { ...preferences.compaction };
      if (field === '开关') { const value = await ctx.ui.select('上下文压缩', ['开启', '关闭']); if (value) preferences.compaction.enabled = value === '开启'; }
      else {
        const key = field === '保留 token' ? 'reserveTokens' : 'keepRecentTokens', value = await ctx.ui.input(field, String(preferences.compaction[key] || ''));
        if (value !== undefined) { if (!/^\d+$/.test(value)) throw new Error('请输入非负整数'); preferences.compaction[key] = Number(value); }
      }
    }
  }
  editDraft(store, id, { preferences });
}

async function requirementsPanel(ctx, store, id) {
  const draft = readDraft(store, id), labels = draft.bindings.map(item => item.name + (item.required ? ' · 必需' : ' · 可选'));
  const selected = await ctx.ui.select('设备需求', [...labels, '新增']); if (!selected) return;
  if (selected === '新增') {
    const name = await ctx.ui.input('需求名称', ''); if (!name?.trim()) return;
    const types = { 配置文件: 'file', 本机工具: 'command', Skill: 'skills', Extension: 'extensions', Prompt: 'prompts', Theme: 'themes' };
    const type = await ctx.ui.select('需求类型', Object.keys(types)); if (!type) return;
    let target;
    if (types[type] === 'file') { target = await ctx.ui.select('配置文件', ['mcp.json', 'sol-pi.json', 'web-search.json']); if (!target) return; }
    const required = await ctx.ui.select('需求', ['必需', '可选']); if (!required) return;
    editDraft(store, id, { bindings: [...draft.bindings, { id: 'device-' + randomUUID().slice(0, 8), name: name.trim(), kind: types[type], required: required === '必需', ...(target ? { target } : {}) }] });
  } else {
    const index = labels.indexOf(selected), item = draft.bindings[index];
    const action = await ctx.ui.select(item.name, ['重命名', item.required ? '改为可选' : '改为必需', '移除']);
    if (action === '重命名') { const name = await ctx.ui.input('需求名称', item.name); if (name?.trim()) item.name = name.trim(); }
    if (action?.startsWith('改为')) item.required = !item.required;
    if (action === '移除') draft.bindings.splice(index, 1);
    editDraft(store, id, { bindings: draft.bindings });
  }
}

export async function draftsPanel(pi, ctx, store) {
  const root = join(store.root, 'drafts');
  const drafts = existsSync(root) ? readdirSync(root).map(id => readJson(join(root, id, 'draft.json'))).filter(draft => draft && !draft.saved && !draft.hidden) : [];
  if (!drafts.length) { ctx.ui.notify('暂无草稿', 'info'); return; }
  const labels = drafts.map(draft => (readJson(join(draft.source, 'preset.json'))?.name || draft.name) + ' · ' + draft.id.slice(0, 8));
  const label = await ctx.ui.select('草稿', labels); if (label) return editPresetPanel(pi, ctx, store, drafts[labels.indexOf(label)].id);
}

export async function bindingsPanel(ctx, store, profile) {
  const bindings = profile.deviceBindings || [], values = deviceValues(store, profile);
  if (!bindings.length) { ctx.ui.notify('无需设备绑定', 'info'); return; }
  const labels = bindings.map(item => item.name + (values[item.id] && existsSync(values[item.id]) ? ' · 已绑定' : item.required ? ' · 必需' : ' · 可选'));
  const label = await ctx.ui.select('设备绑定', labels); if (!label) return;
  const item = bindings[labels.indexOf(label)], path = await ctx.ui.input(item.name, values[item.id] || '');
  if (path) { bindDevice(store, profile, item.id, resolve(ctx.cwd, path.replace(/^~\//, process.env.HOME + '/'))); ctx.ui.notify('已绑定当前设备', 'info'); }
}
