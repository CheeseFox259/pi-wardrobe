import { workflowView } from './workflow-view.mjs';
import { choosePreset, presetRoster, presetKey, createPresetPanel, editPresetPanel, draftsPanel, bindingsPanel } from './native-menu.mjs';
import { bindDevice } from './native-bindings.mjs';
import { createDraft, draftFromProfile, saveDraft, exportProfile, importLocal } from './native-authoring.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adoptOriginal } from './native-adoption.mjs';
import { executeProfile, profileInvocation } from './native-bootstrap.mjs';
import { reviewNativeImport, installNativePlan, checkPreparedProfile, refreshProfileCache, nativeEnv } from './native-service.mjs';
import { profilePlan } from './native-updates.mjs';
import { checkNativeOwnership, nativeUsers } from './native-ownership.mjs';
import { diagnoseRevision } from './doctor.mjs';
import { StagingStore } from './staging.mjs';
import { runCommand } from './commands.mjs';
import { nativeReviewSummary } from './native-review.mjs';
import { NATIVE_RESULT, readJson, writeJson, projectKey } from './native-store.mjs';
import { beginWorkflow, currentWorkflowRoot, verifyWorkflow, installWorkflow, resumeWorkflow } from './native-workflow.mjs';
import { recordNativeSession } from './native-history.mjs';
export { recordNativeSession } from './native-history.mjs';

function profileFor(store, selector) {
  const config = store.read();
  if (config.profiles[selector]) return config.profiles[selector];
  const matches = presetRoster(store).filter(item => item.key === selector || item.revisions.some(profile => profile.name === selector || profile.source?.id === selector)).map(item => item.profile);
  if (matches.length !== 1) throw new Error(matches.length ? 'More than one version matches; select it from /wardrobe.' : 'Preset is not installed: ' + selector);
  return matches[0];
}

function profileLabels(profiles) {
  const labels = profiles.map(profile => `${profile.name} · ${profile.version}`);
  return labels.map((label, index) => labels.indexOf(label) !== labels.lastIndexOf(label) ? `${label} · ${profiles[index].id}` : label);
}

export async function handoffNative(store, profile, ctx, { sessionFile = null } = {}) {
  if (!ctx.isIdle() || ctx.isCompacting?.()) throw new Error('等待当前工作完成后再切换 preset。');
  if (typeof process.execve !== 'function' || !['darwin', 'linux'].includes(process.platform)) throw new Error('自动交接需要 macOS/Linux 和 Node 22.19+；当前会话保持不变。');
  try { checkPreparedProfile(profile); }
  catch (error) {
    if (!profile || !await ctx.ui.confirm('恢复 preset 资源', error.message + (profile.kind === 'original' ? '\n从原始配置备份和保留的本机资源重建，并保留旧对话？' : '\n按原来的固定计划重新安装并保留旧对话？'))) throw error;
    profile = profile.kind === 'original' ? adoptOriginal(store.nativeDir, { restore: true }).profile : await installNativePlan(store, profilePlan(store, profile), { source: profile.source, parent: profile.parent, repair: true, onProgress: entry => ctx.ui.notify(`恢复 ${entry.current}/${entry.total} · ${entry.alias}`, 'info') });
  }
  checkNativeOwnership(store, profile);
  const invocation = await profileInvocation(store, profile, { cwd: ctx.cwd, sessionFile, newSession: !sessionFile });
  if (!existsSync(invocation.args[1])) throw new Error('Pi executable is missing; current session was not changed.');
  process.once('exit', () => executeProfile(invocation));
  ctx.shutdown();
}

export async function nativePanel(pi, ctx, store) {
  if (!store.read().initialized) {
    if (!await ctx.ui.confirm('欢迎使用 Wardrobe', '保存当前全局配置为“我的原始配置”？')) return;
    adoptOriginal(store.nativeDir); recordNativeSession(pi, ctx, store);
  }
  let selectedId = process.env.WARDROBE_NATIVE_PROFILE || 'original';
  for (;;) {
    const choice = await choosePreset(ctx, store, selectedId);
    if (!choice) return;
    if (choice.profile) selectedId = choice.profile.id;
    if (choice.action === 'use') return handleNativeCommand(pi, 'use ' + choice.profile.id, ctx, store);
    let outcome;
    if (choice.action === 'manage') outcome = await profilePanel(pi, ctx, store, choice.profile);
    if (choice.action === 'create') outcome = await createPresetPanel(pi, ctx, store);
    if (choice.action === 'drafts') outcome = await draftsPanel(pi, ctx, store);
    if (outcome === 'handoff' || outcome === 'model') return;
    if (outcome?.id) selectedId = outcome.id;
    if (choice.action === 'resume') return handleNativeCommand(pi, 'resume', ctx, store);
    if (choice.action === 'import') {
      const type = await ctx.ui.select('导入预设', ['本地', 'GitHub / Git', 'npm']);
      if (!type) continue;
      const source = await ctx.ui.input(type === '本地' ? '目录或 preset.json' : '来源', type === '本地' ? '' : type === 'npm' ? 'npm:package' : 'owner/repository');
      if (source) {
        const before = new Set(Object.keys(store.read().profiles));
        await handleNativeCommand(pi, 'import ' + JSON.stringify(source), ctx, store);
        selectedId = Object.keys(store.read().profiles).filter(id => !before.has(id)).at(-1) || selectedId;
      }
    }
  }
}

async function profilePanel(pi, ctx, store, profile) {
  const selected = await ctx.ui.select(profile.name, ['编辑', '复制', '更新', '维护', '启动默认', '导出', '更多']);
  if (selected === '编辑' || selected === '复制') {
    const draft = await draftFromProfile(store, profile, { copy: selected === '复制' });
    return editPresetPanel(pi, ctx, store, draft.id);
  }
  if (selected === '启动默认') {
    const choice = await ctx.ui.select('启动默认', ['全局默认', '项目默认', '项目跟随全局']);
    if (choice) return handleNativeCommand(pi, choice === '项目跟随全局' ? 'default --project --clear' : 'default ' + profile.id + (choice === '项目默认' ? ' --project' : ''), ctx, store);
  }
  if (selected === '更新') {
    await handleNativeCommand(pi, 'update ' + profile.id, ctx, store); return 'model';
  }
  if (selected === '维护') {
    const request = await ctx.ui.input('修复问题或增加能力', '');
    if(request){await handleNativeCommand(pi,'maintain '+profile.id+' --request '+JSON.stringify(request),ctx,store);return 'model';}
  }
  if (selected === '导出') {
    const destination = await ctx.ui.input('导出到新目录', '');
    if (destination) return handleNativeCommand(pi, 'export ' + profile.id + ' ' + JSON.stringify(destination), ctx, store);
  }
  if (selected === '更多') {
    const choice = await ctx.ui.select(profile.name, ['设备绑定', '版本', '重命名', '详情', '修复', '移除']);
    if (choice === '设备绑定') return bindingsPanel(ctx, store, profile);
    if (choice === '版本') {
      const revisions = presetRoster(store).find(item => item.key === presetKey(profile)).revisions.toReversed();
      const labels = revisions.map((p, i) => p.version + ' · ' + (p.createdAt?.slice(0, 16) || p.id) + ' · ' + (i + 1));
      const version = await ctx.ui.select('版本', labels);
      if (version) { await handleNativeCommand(pi, 'use ' + revisions[labels.indexOf(version)].id, ctx, store); return 'handoff'; }
    }
    if (choice === '重命名') {
      const draft = await draftFromProfile(store, profile); return editPresetPanel(pi, ctx, store, draft.id);
    }
    if (['详情', '修复', '移除'].includes(choice)) return handleNativeCommand(pi, { 详情: 'details', 修复: 'repair', 移除: 'uninstall' }[choice] + ' ' + profile.id, ctx, store);
  }
}

export async function handleNativeCommand(pi, args, ctx, store) {
  const progress = entry => ctx.ui.notify(`安装 ${entry.current}/${entry.total} · ${entry.alias}`, 'info');
  const result = data => { pi.appendEntry(NATIVE_RESULT, data); return true; };
  try {
    const tokens = (args.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) || []).map(token => token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1) : token), [command, selector] = tokens;
    if (!args.trim() || command === 'help') { await nativePanel(pi, ctx, store); return true; }
    if (command === 'create' && tokens.length === 1 && ctx.hasUI) { await createPresetPanel(pi, ctx, store); return true; }
    if (command === 'create' || command === 'edit' || command === 'copy') {
      const at = tokens.indexOf('--name');
      const from = tokens.indexOf('--from'), name = at >= 0 ? tokens[at + 1] : undefined;
      const profile = command !== 'create' ? profileFor(store, selector) : from >= 0 ? profileFor(store, tokens[from + 1]) : store.read().profiles[process.env.WARDROBE_NATIVE_PROFILE || 'original'];
      const draft = tokens.includes('--blank') || !profile ? createDraft(store, { name }) : await draftFromProfile(store, profile, { copy: command !== 'edit', ...(name ? { name } : {}) });
      ctx.ui.notify('草稿已准备：/wardrobe draft ' + draft.id, 'info');
      return result({ ok: true, state: 'draft', draft });
    }
    if (command === 'draft') { await editPresetPanel(pi, ctx, store, selector); return true; }
    if (command === 'drafts') { await draftsPanel(pi, ctx, store); return true; }
    if (command === 'bind') {
      if (!Object.keys(store.read().profiles).length || tokens.includes('--mode')) return false;
      const profile = profileFor(store, selector);
      if (!tokens[2] || !tokens[3]) throw new Error('请选择设备需求和本机路径');
      const path = bindDevice(store, profile, tokens[2], resolve(ctx.cwd, tokens[3].replace(/^~\//, process.env.HOME + '/')));
      return result({ ok: true, state: 'bound', path });
    }
    if (command === 'save') {
      const profile = await saveDraft(store, selector, { confirm: plan => tokens.includes('--yes') || ctx.ui.confirm('保存 ' + plan.declaration.name, nativeReviewSummary(plan)), onProgress: progress });
      return result({ ok: true, state: profile ? 'saved' : 'cancelled', profile, active: false });
    }
    if (command === 'export') {
      const profile = profileFor(store, selector);
      const destination = tokens[2];
      if (!destination) throw new Error('请选择导出目录');
      const target = await exportProfile(store, profile, resolve(ctx.cwd, destination.replace(/^~\//, process.env.HOME + '/')));
      return result({ ok: true, state: 'exported', destination: target });
    }
    if (command === 'details') {
      const profile = profileFor(store, selector);
      ctx.ui.notify([`${profile.name} · ${profile.version}`, profile.source?.locator || '本机配置', profile.source?.commit?.slice(0, 12), profile.compatibility?.pi && 'Pi ' + profile.compatibility.pi, profile.kind === 'derivative' && '本地派生版本'].filter(Boolean).join('\n'), 'info');
      return result({ ok: true, profile });
    }
    if (command === 'update' || command === 'maintain') {
      if (!ctx.isIdle() || ctx.isCompacting?.()) throw new Error('请等待当前任务完成');
      const at=tokens.indexOf('--source'),source=at>=0?resolve(ctx.cwd,tokens[at+1]):null;
      const profile=source?null:profileFor(store, selector && !selector.startsWith('--') ? selector : process.env.WARDROBE_NATIVE_PROFILE || 'original');
      const requestAt=tokens.indexOf('--request'),request=requestAt>=0?tokens[requestAt+1]:'';
      if(tokens.includes('--verify')||tokens.includes('--apply')){
        if(!profile)throw new Error('使用 wardrobe_workflow 的 workflow 路径验证或安装来源目录');
        const root=currentWorkflowRoot(store,profile,command);
        const outcome=tokens.includes('--verify')?await verifyWorkflow(store,root):await installWorkflow(store,root,{approved:tokens.includes('--yes'),confirm:async definition=>ctx.ui.confirm('安装 '+definition.name,'使用已验证的更新结果？')});
        ctx.ui.notify(outcome.status,'info');return result(outcome);
      }
      const {workflowContextFor}=await import('./workflow-context.mjs');
      workflowContextFor(pi,store).start();
      pi.appendEntry?.('wardrobe.workflow',{action:command,status:'STARTING'});
      let outcome=await beginWorkflow(store,{profile,source,mode:command,request,review:command==='update'?'human':undefined});
      if(['WAITING_INPUT','PLAN_APPROVED'].includes(outcome.status)&&outcome.planReview&&!tokens.includes('--prepare')){
        const confirm=ctx.hasUI!==false&&ctx.ui?.confirm?(title,body)=>ctx.ui.confirm(title,body):undefined;
        outcome=await resumeWorkflow(store,outcome.workspace.root,{confirm,revise:tokens.includes('--revise')});
      }
      if(outcome.workspace?.root)pi.appendEntry?.('wardrobe.workflow',{action:command,status:outcome.status,workflow:outcome.workspace.root});
      if(outcome.modelRequired&&!tokens.includes('--prepare')) {
        workflowContextFor(pi,store).accept(outcome);
        const content=JSON.stringify(workflowView(outcome));
        if(pi.sendMessage)pi.sendMessage({customType:'wardrobe.'+command,content,display:false},{triggerTurn:true});
        else pi.sendUserMessage(content);
      }else ctx.ui.notify(outcome.status==='PLAN_APPROVED'?'方案已获确认。再次运行 /wardrobe update 开始实施。':outcome.message || outcome.status,outcome.status==='BLOCKED'?'error':'info');
      return result(outcome);
    }
    if (command === 'adopt') {
      if (!tokens.includes('--yes') && !await ctx.ui.confirm('我的原始配置', '保存当前全局配置？')) return true;
      const adopted = adoptOriginal(store.nativeDir); recordNativeSession(pi, ctx, store);
      ctx.ui.notify('已保存我的原始配置', 'info');
      return result(adopted);
    }
    if ((command === 'current' || command === 'presets') && !Object.keys(store.read().profiles).length) return false;
    if (command === 'current' || command === 'presets') {
      const config = store.read();
      const active = config.profiles[process.env.WARDROBE_NATIVE_PROFILE] ?? (config.initialized ? config.profiles.original : null);
      ctx.ui.notify(command === 'presets' ? Object.values(config.profiles).map(profile => `${profile.name} · ${profile.version}`).join('\n') : `${active?.name || '原生 Pi'}\n全局默认：${config.profiles[config.default]?.name || '未设置'}\n项目默认：${config.profiles[config.projects[projectKey(ctx.cwd)]]?.name || '跟随全局'}`, 'info');
      return result({ ok: true, profile: config.profiles[process.env.WARDROBE_NATIVE_PROFILE] ?? null, presets: Object.values(config.profiles), nativeAgentDir: store.nativeDir, agentDir: process.env.PI_CODING_AGENT_DIR });
    }
    if (command === 'default') {
      if (tokens.includes('--project') && tokens.includes('--clear')) {
        const config = store.read(); delete config.projects[projectKey(ctx.cwd)]; store.save(config);
        ctx.ui.notify('项目已跟随全局默认', 'info');
        return result({ ok: true, state: 'project-default-cleared' });
      }
      const profile = profileFor(store, selector), config = store.read();
      if (tokens.includes('--project')) config.projects[projectKey(ctx.cwd)] = profile.id; else config.default = profile.id;
      store.save(config); ctx.ui.notify('已设置启动默认', 'info');
      return result({ ok: true, state: 'default-saved', profile });
    }
    if (command === 'import' && selector && existsSync(resolve(ctx.cwd, selector.replace(/^~\//, process.env.HOME + '/')))) {
      const profile = await importLocal(store, resolve(ctx.cwd, selector.replace(/^~\//, process.env.HOME + '/')), { confirm: plan => tokens.includes('--yes') || ctx.ui.confirm('导入 ' + plan.declaration.name, nativeReviewSummary(plan)), onProgress: progress, presetPath: tokens.includes('--preset') ? tokens[tokens.indexOf('--preset') + 1] : null, choose: async entries => {
        const labels = entries.map(entry => entry.definition.name + ' · ' + entry.path), choice = await ctx.ui.select('选择预设', labels);
        return choice ? entries[labels.indexOf(choice)].path : undefined;
      } });
      return result({ ok: true, state: profile ? 'installed' : 'cancelled', profile, active: false });
    }
    if (command === 'import') {
      const preset = tokens.indexOf('--preset');
      const reviewed = await reviewNativeImport(store, selector, preset >= 0 ? tokens[preset + 1] : null, { ref: tokens.includes('--ref') ? tokens[tokens.indexOf('--ref') + 1] : null, choose: async entries => {
        const labels = entries.map(entry => entry.definition.name + ' · ' + entry.path);
        const chosen = await ctx.ui.select('选择仓库中的 preset', labels);
        return chosen ? entries[labels.indexOf(chosen)].path : undefined;
      } });
      if (!reviewed) return true;
      const { plan } = reviewed;
      if (!tokens.includes('--yes') && !await ctx.ui.confirm('安装 ' + plan.declaration.name, nativeReviewSummary(plan))) return true;
      const profile = await installNativePlan(store, plan, { source: reviewed.source, onProgress: progress });
      ctx.ui.notify('已安装 ' + profile.name, 'info');
      return result({ ok: true, state: 'installed', profile, active: false });
    }
    if (command === 'repair') {
      const old = profileFor(store, selector);
      if (old.kind === 'original') {
        if (!tokens.includes('--yes') && !await ctx.ui.confirm('修复我的原始配置', '从首次归档重建？')) return true;
        const restored = adoptOriginal(store.nativeDir, { restore: true });
        ctx.ui.notify('原始配置已恢复', 'info');
        return result({ ...restored, active: false });
      }
      const plan = profilePlan(store, old);
      if (!tokens.includes('--yes') && !await ctx.ui.confirm('恢复原固定版本', nativeReviewSummary(plan))) return true;
      const profile = await installNativePlan(store, plan, { source: old.source, parent: old.parent, repair: true, onProgress: progress });
      ctx.ui.notify('资源已恢复', 'info');
      return result({ ok: true, state: 'repaired', profile, active: false });
    }
    if (command === 'uninstall') {
      const profile = profileFor(store, selector);
      if (!profile.revision) {
        const config = store.read(), sessions = join(store.root, 'sessions');
        if (config.default === profile.id || Object.values(config.projects).includes(profile.id) || nativeUsers(store, profile).length || existsSync(sessions) && readdirSync(sessions).some(file => { const session = readJson(join(sessions, file)); return session?.profile === profile.id && session.sessionFile && existsSync(session.sessionFile); })) throw new Error('此版本仍被默认、运行实例或旧对话引用，请保留以便恢复');
        if (!tokens.includes('--yes') && !await ctx.ui.confirm('移除', profile.name + '？')) return true;
        delete config.profiles[profile.id]; store.save(config);
        return result({ ok: true, state: 'removed', profile: profile.id });
      }
      const plan = profilePlan(store, profile);
      if (!tokens.includes('--yes') && !await ctx.ui.confirm('移除', profile.name + ' ' + profile.version + '？')) return true;
      const response = await runCommand(`remove ${plan.identity.id} --revision ${profile.revision}`, { env: nativeEnv(store) });
      ctx.ui.notify(response.result.text, response.ok ? 'info' : 'error');
      return result({ ok: response.ok, state: response.result.state, detail: response.result });
    }
    if (command === 'verify') {
      const profile = profileFor(store, selector), plan = profilePlan(store, profile);
      ctx.ui.notify('正在校验…', 'info');
      const report = await diagnoseRevision(new StagingStore(store.nativeDir).read(profile.revision), { env: nativeEnv(store), plan });
      if (report.drift.length || report.unverified.some(entry => entry.component !== 'baseline')) throw new Error('完整校验未通过：' + JSON.stringify({ drift: report.drift, unverified: report.unverified }));
      refreshProfileCache(profile, plan, new StagingStore(store.nativeDir).read(profile.revision));
      ctx.ui.notify('校验通过', 'info');
      return result({ ok: true, state: 'verified', profile: profile.id, historicalBaseline: report.state });
    }
    if (command === 'update-manager' || command === 'update-pi' || command === 'upgrade') {
      ctx.ui.notify('请使用 pi update', 'info');
      return result({ ok: true, state: 'native-update' });
    }
    if (command === 'updates') {
      const profiles = Object.values(store.read().profiles).filter(profile => profile.source?.locator);
      if (!profiles.length) { ctx.ui.notify('暂无可更新的 preset', 'info'); return result({ ok: true, state: 'no-upstream' }); }
      const options = profileLabels(profiles);
      const choice = await ctx.ui.select('更新 preset', options);
      if (!choice) return true;
      return handleNativeCommand(pi, 'update ' + profiles[options.indexOf(choice)].id, ctx, store);
    }
    if (command === 'pull') {
      const old = profileFor(store, selector);
      return handleNativeCommand(pi, 'update ' + old.id + (tokens.includes('--prepare') ? ' --prepare' : ''), ctx, store);
    }
    if (command === 'resume') {
      const directory = join(store.root, 'sessions');
      const sessions = existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json')).map(file => readJson(join(directory, file))).filter(entry => entry.sessionFile && existsSync(entry.sessionFile) && store.read().profiles[entry.profile]) : [];
      let selected = selector ? sessions.find(entry => entry.sessionId === selector) : null;
      if (!selector) {
        const labels = sessions.map(entry => `${entry.name || entry.sessionId} · ${store.read().profiles[entry.profile].name}`);
        const label = await ctx.ui.select('恢复对话', labels);
        if (!label) return true;
        selected = sessions[labels.indexOf(label)];
      }
      if (!selected) throw new Error('未找到可恢复的已绑定对话。');
      await handoffNative(store, profileFor(store, selected.profile), ctx, { sessionFile: selected.sessionFile });
      return true;
    }
    if (command === 'use' && !Object.keys(store.read().profiles).length) return false;
    if (command === 'use') { await handoffNative(store, profileFor(store, selector), ctx); return true; }
    return false;
  } catch (error) { ctx.ui.notify(error.message, 'error'); return result({ ok: false, error: error.message }); }
}
