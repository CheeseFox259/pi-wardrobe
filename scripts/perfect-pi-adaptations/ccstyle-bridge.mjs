// One execution chain: SoL queue/guard -> ccstyle metadata/native write.
// Symbol.for keeps the delegate shared across Pi's extension loader and /reload.
import { resolve } from 'node:path';
const state = globalThis[Symbol.for('perfect-pi.fused-write')] ??= {};
export function claimFusedWrite(path) { state.owner = resolve(path); }
export function releaseFusedWrite() { delete state.owner; delete state.execute; }
export function executeStyledWrite(fallback, id, params, signal, update, ctx) {
  const execute = state.owner && state.execute || fallback;
  return execute(id, params, signal, update, ctx);
}
export function coordinateCcstyle(pi) {
  const isPartner = tool => tool.name === 'write' && typeof tool.sourceInfo?.path === 'string'
    && state.owner && resolve(tool.sourceInfo.path) === state.owner;
  const bridge = Object.create(pi);
  // In ccstyle's view the cooperating writer needs no conflict fallback. Its
  // attempted override becomes the inner executor, never a second registration.
  bridge.getAllTools = () => pi.getAllTools().map(tool => isPartner(tool)
    ? {...tool,sourceInfo:{...tool.sourceInfo,source:'builtin'}} : tool);
  bridge.registerTool = tool => {
    if (tool.name === 'write' && pi.getAllTools().some(isPartner)) state.execute = tool.execute;
    else pi.registerTool(tool);
  };
  return bridge;
}
