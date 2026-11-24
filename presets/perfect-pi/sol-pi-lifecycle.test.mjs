import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { detectPiRuntime, resolvePiSubpackage } from "./scripts/pi-runtime.mjs";
import { authorizeReducer, reducerDecision, requestReducerConsent, resetReducerConsent } from "./global/extensions/sol-pi-consent.mjs";

const runtime = await detectPiRuntime();
const root = runtime?.root ?? join(execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const pi = await import(pathToFileURL(join(root, "dist/index.js")));
const { createJiti } = await import(pathToFileURL(join(root, "dist/core/extensions/jiti-loader.js")));
const require = createRequire(join(root, "dist/index.js"));
const jiti = createJiti(join(root, "dist/index.js"), { alias: { typebox: require.resolve("typebox"), "@earendil-works/pi-coding-agent": join(root, "dist/index.js"), "@earendil-works/pi-tui": await resolvePiSubpackage('pi-tui', 'dist/index.js', { runtime }), "@earendil-works/pi-ai/compat": await resolvePiSubpackage('pi-ai', 'dist/compat.js', { runtime }) } });
const { registerAccountedReducer } = await jiti.import(join(import.meta.dirname, "global/extensions/sol-pi.ts"));
const route = "cpa/gemini-3.8-flash-high";
const model = { provider: "cpa", id: "gemini-3.8-flash-high" };
const config = { evidencePreservingReducerProvider: model.provider, evidencePreservingReducerModel: model.id };
function fixture({ limit = 2, manager = pi.SessionManager.inMemory(), decision = "Allow", fail = false } = {}) {
  resetReducerConsent(manager.getSessionId());
  let handler, prompts = 0, requests = 0;
  const selectedModels = [];
  const controller = new AbortController();
  const api = { on(_name, value) { handler = value; }, appendEntry(type, data) { manager.appendCustomEntry(type, data); } };
  const ctx = { model, sessionManager: manager, hasUI: true, mode: "tui", signal: controller.signal,
    ui: { select: async () => { prompts++; return decision; } },
    modelRegistry: { find: () => model, complete: async selected => { selectedModels.push(selected); requests++; if (fail) throw new Error("synthetic network exception"); return { usage: { input: 5, output: 2 } }; } } };
  const reducer = { registerEvidencePreservingReducer(bridge) { bridge.on("tool_result", async (_event, context) => {
    await context.modelRegistry.complete(context.modelRegistry.find("unused", "unused"), {}, { signal: context.signal });
    return undefined;
  }); } };
  const register = () => registerAccountedReducer(api, reducer, config, { reducerPolicy: { provider: model.provider, model: model.id, maxRequestsPerSession: limit } });
  register();
  return { ctx, manager, controller, register, selectedModels, run: () => handler({ toolName: "bash", toolCallId: "synthetic" }, ctx),
    get prompts() { return prompts; }, get requests() { return requests; } };
}

test("parallel grant emits exactly one durable decision", async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.prompts, 1);
  assert.equal(f.requests, 2);
  assert.equal(f.manager.getEntries().filter(e => e.customType === "perfect-pi-sol-reducer-authorized").length, 1);
});
test("deny is restored across registration and memory reset without nagging", async () => {
  const f = fixture({ decision: "Deny" });
  await f.run();
  resetReducerConsent(f.manager.getSessionId()); f.register();
  await f.run();
  assert.equal(f.prompts, 1); assert.equal(f.requests, 0);
  assert.equal(reducerDecision(f.manager.getSessionId(), route), false);
});
test("cancel is not denial and can be asked again", async () => {
  const f = fixture({ decision: undefined });
  f.ctx.ui.select = async () => undefined;
  await f.run();
  assert.equal(reducerDecision(f.manager.getSessionId(), route), undefined);
  f.ctx.ui.select = async () => "Allow";
  await f.run(); assert.equal(f.requests, 1);
});
test("fork and changed routes cannot reuse a previous consent receipt", async () => {
  const f = fixture(); await f.run();
  const parent = f.manager.getSessionId();
  const leaf = f.manager.appendMessage({ role: "user", content: [{ type: "text", text: "synthetic" }], timestamp: Date.now() });
  f.manager.createBranchedSession(leaf);
  assert.notEqual(f.manager.getSessionId(), parent);
  const child = fixture({ manager: f.manager, decision: "Deny" });
  await child.run(); assert.equal(child.prompts, 1); assert.equal(child.requests, 0);
  const foreign = pi.SessionManager.inMemory();
  foreign.appendCustomEntry("perfect-pi-sol-reducer-authorized", { sessionId: foreign.getSessionId(), route: "other/model" });
  const changed = fixture({ manager: foreign, decision: "Deny" });
  await changed.run(); assert.equal(changed.prompts, 1); assert.equal(changed.requests, 0);
});
test("network exceptions reserve budget across reload, including concurrent calls", async () => {
  const f = fixture({ fail: true });
  authorizeReducer(f.manager.getSessionId(), route);
  await Promise.all([f.run(), f.run(), f.run()]);
  f.register(); await f.run();
  assert.equal(f.requests, 2);
  assert.equal(f.manager.getEntries().filter(e => e.customType === "perfect-pi-sol-reducer-attempt").length, 2);
  assert.equal(f.manager.getEntries().filter(e => e.customType === "perfect-pi-sol-reducer-call-failed").length, 2);
});
test("reset cancels old prompt without deleting a replacement", async () => {
  resetReducerConsent(); let finish;
  const old = requestReducerConsent("same", () => new Promise(() => {}));
  await Promise.resolve(); resetReducerConsent("same");
  const current = requestReducerConsent("same", () => new Promise(resolve => { finish = resolve; }));
  await old; await Promise.resolve();
  assert.equal(requestReducerConsent("same", () => Promise.resolve(false)), current);
  finish(true); assert.equal(await current, true);
});
test("prompt deadline and already aborted signals settle without dispatch", async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  assert.equal(await requestReducerConsent("abort", () => { called = true; }, { signal: controller.signal }), undefined);
  assert.equal(called, false);
  assert.equal(await requestReducerConsent("timeout", () => new Promise(() => {}), { timeout: 10 }), undefined);
});
test("real Pi selector: request dedup, Escape and run abort release dialogs", async () => {
  const { InteractiveMode } = await import(pathToFileURL(join(root, "dist/modes/interactive/interactive-mode.js")));
  const { initTheme } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")));
  initTheme("dark", false);
  const mode = Object.create(InteractiveMode.prototype);
  mode.editor = {}; mode.editorContainer = { clear() {}, addChild() {} };
  mode.ui = { setFocus() {}, requestRender() {} };
  mode.programStatus = { setBlocked() {} };
  const controller = new AbortController();
  const prompt = (signal) => mode.showExtensionSelector("Synthetic permission", ["Allow", "Deny"], { signal });
  const first = requestReducerConsent("native", prompt, { signal: controller.signal });
  const second = requestReducerConsent("native", prompt, { signal: controller.signal });
  assert.equal(first, second); await Promise.resolve();
  mode.extensionSelector.handleInput("\x1b"); assert.equal(await first, undefined);
  const next = requestReducerConsent("native", prompt, { signal: controller.signal });
  await Promise.resolve(); controller.abort(); assert.equal(await next, undefined);
});

test("reducer follows Pi model changes and requests consent for the new route", async () => {
  const f = fixture();
  await f.run();
  f.ctx.model = { provider: "pi-user", id: "chosen" };
  await f.run();
  assert.deepEqual(f.selectedModels, [model, f.ctx.model]);
  assert.equal(f.prompts, 2);
});

test('maintained OCC inherits native per-model compaction settings and preserves progress across the merge', async () => {
  const module = await jiti.import(join(import.meta.dirname, 'vendor/sol-pi/src/sol-pi/extensions/online-context-compact/index.ts'));
  assert.deepEqual(module.resolveCompactionTokenSettings({ compaction: { keepRecentTokens: 20000, reserveTokens: 16384, modelOverrides: { 'native/model': { keepRecentTokens: 30000 } } } }, { provider: 'native', id: 'model' }), { keepRecentTokens: 30000, reserveTokens: 16384 });
  assert.match(module.buildCompactionInstructions([{ stepId: 'merge', goal: 'Keep local behavior', filesChanged: ['adapter.ts'], verification: ['native test passed'], decisions: ['Pi owns models'], nextWork: ['report'] }]), /native test passed/);
  const state = await jiti.import(join(import.meta.dirname, 'vendor/sol-pi/src/sol-pi/extensions/online-context-compact/state.ts'));
  const initial = { ...state.initialOnlineState(), requestCount: 9, lastBoundaryRequestCount: 2, completedBoundaryRequestCounts: [2, 5] };
  const compacted = state.recordCompaction(initial, { debtTokens: 10000, repaymentTokens: 2000 });
  assert.deepEqual(compacted.completedBoundaryRequestCounts, []);
  assert.equal(compacted.lastBoundaryRequestCount, 9);
});

test('nested codemode diagnostic results bypass reduction before any model request', async () => {
  const { reduceToolResult } = await jiti.import(join(import.meta.dirname, 'vendor/sol-pi/src/sol-pi/extensions/evidence-preserving-reducer/index.ts'));
  const result = await reduceToolResult(() => { throw new Error('nested result must bypass the reducer'); }, {}, { parentToolCallId: 'codemode-call', toolName: 'bash', toolCallId: 'codemode-call/1', content: [{ type: 'text', text: 'diagnostic'.repeat(2000) }] }, {});
  assert.equal(result, undefined);
});
