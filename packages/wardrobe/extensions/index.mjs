import { NativeStore, nativeDirectory } from '../src/native-store.mjs';
import { bootstrapNative } from '../src/native-bootstrap.mjs';
import { recordNativeSession, sessionProfile } from '../src/native-history.mjs';
import { registerWorkflowTool } from '../src/workflow-tool.mjs';

export default async function wardrobe(pi) {
  const store = new NativeStore(nativeDirectory());
  let startupError = null;
  let restoreSession = false;
  try { restoreSession = (await bootstrapNative(store))?.restoreSession === true; } catch (error) { startupError = error; }
  registerWorkflowTool(pi, store);
  const decorate = definition => ({ ...definition, description: 'Presets', getArgumentCompletions: prefix => {
    const choices = ['create', 'edit', 'copy', 'drafts', 'draft', 'save', 'import', 'export', 'bind', 'current', 'presets', 'use', 'default', 'updates', 'update', 'maintain', 'details', 'resume', 'verify', 'repair'];
    return choices.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
  }, handler: async (args, ctx) => {
    const {handleNativeCommand}=await import('../src/native-flow.mjs');
    if (!await handleNativeCommand(pi, args, ctx, store)) await definition.handler(args, ctx);
  } });
  if (process.env.WARDROBE_NATIVE_PROFILE) {
    pi.registerCommand('wardrobe', decorate({ handler: async (args, ctx) => {
      const {runCommand,withText}=await import('../src/commands.mjs');
      const response = withText(await runCommand(args, { env: { ...process.env, PI_CODING_AGENT_DIR: store.nativeDir, WARDROBE_AGENT_DIR: store.nativeDir } }));
      pi.appendEntry('wardrobe.result', response.result); ctx.ui.notify(response.result.text, response.ok ? 'info' : 'error');
    } }));
  } else {
    const {default:legacy}=await import('./wardrobe.mjs');
    legacy(new Proxy(pi, { get(target, key) {
      return key === 'registerCommand' ? (name, definition) => target.registerCommand(name, name === 'wardrobe' ? decorate(definition) : definition) : Reflect.get(target, key);
    } }));
  }
  pi.on('session_before_switch', async (event, ctx) => {
    if (!event.targetSessionFile) return;
    const id = sessionProfile(store, event.targetSessionFile) ?? (store.read().initialized ? 'original' : null);
    if (!id) return;
    if (id === process.env.WARDROBE_NATIVE_PROFILE) return;
    try { const {handoffNative}=await import('../src/native-flow.mjs');await handoffNative(store, store.read().profiles[id], ctx, { sessionFile: event.targetSessionFile }); }
    catch (error) { ctx.ui.notify(error.message, 'error'); }
    return { cancel: true };
  });
  pi.on('before_agent_start', event => {
    const profile = store.read().profiles[process.env.WARDROBE_NATIVE_PROFILE];
    if (profile?.persona?.length) event.systemPromptOptions.promptGuidelines = [...(event.systemPromptOptions.promptGuidelines ?? []), ...profile.persona];
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!store.read().initialized) ctx.ui.setWidget?.('wardrobe', ['Preset: 原生 Pi'], { placement: 'aboveEditor' });
    if (restoreSession && !startupError) {
      restoreSession = false;
      try {
        const file = ctx.sessionManager.getSessionFile();
        const id = file ? sessionProfile(store, file) ?? 'original' : null;
        const profile = store.select(ctx.cwd, id);
        if (profile) { const {handoffNative}=await import('../src/native-flow.mjs');await handoffNative(store, profile, ctx, { sessionFile: file }); return; }
      } catch (error) { startupError = error; }
    }
    if (!startupError) try { recordNativeSession(pi, ctx, store); } catch (error) { startupError = error; }
    if (startupError) ctx.ui.notify('Preset 启动未完成：' + startupError.message + '\n可用 /wardrobe 修复或选择其他启动默认；当前环境暂停接受模型任务。', 'error');
  });
  pi.on('input', (_event, ctx) => {
    if (!startupError) return { action: 'continue' };
    ctx.ui.notify('请先在 /wardrobe 中修复启动默认：' + startupError.message, 'error');
    return { action: 'handled' };
  });
}
