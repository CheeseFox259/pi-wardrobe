// Local adaptations to the pinned upstream: Pi owns model choice and credentials.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const excludedModelAdapters = ['global/extensions/compaction-model.ts', 'global/extensions/subagent-policy.ts'];
export function adaptModelOwnership(root) {
  const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const save = (path, value) => writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
  const edit = (path, transform) => writeFileSync(join(root, path), transform(readFileSync(join(root, path), 'utf8')));
  const manifest = json('manifest.json');
  delete manifest.defaultSettings.perfectPiCompaction;
  delete manifest.solPi.reducerPolicy.provider;
  delete manifest.solPi.reducerPolicy.model;
  save('manifest.json', manifest);
  const sol = json('global/sol-pi.json');
  delete sol.evidencePreservingReducerProvider;
  delete sol.evidencePreservingReducerModel;
  save('global/sol-pi.json', sol);
  for (const role of readdirSync(join(root, 'global/agents')).filter(name => name.endsWith('.md'))) {
    edit('global/agents/' + role, text => text.replace(/^model:.*\n/gm, ''));
  }
  edit('skills/implement-spec/SKILL.md', text => text
    .replace(/^- \*\*Model policy\*\*:.*$/m, '- **Model selection**: Pi owns model selection and authentication. Use Pi native settings and commands. Child sessions use the selection available to their Pi runtime; supply an explicit model only when the user requests it.')
    .replace('separate windows per ticket running `cpa/gemini-3.8-flash-high:high`', 'separate windows per ticket using Pi native model selection'));
  edit('global/extensions/tmux-supervisor.ts', text => text.replace('runs children with cpa/gemini-3.8-flash-high', 'runs children using Pi native model selection'));
  edit('docs/sol-pi.md', text => text
    .replace(/^The reducer route is fixed.*$/m, "The reducer uses Pi's current model at each tool result. A native model change requires consent for the new route. Pi owns provider configuration and credentials; legacy project reducer model fields are ignored. If the model is unavailable, reduction fails, a receipt is invalid, or the request budget is exhausted, the original log is retained.")
    .replace(/## Compaction Model\n[\s\S]*?(?=\n## |$)/, '## Compaction Model\n\nPi handles manual, capacity/overflow and SoL-Pi OCC compaction using its native model selection. Choose models through Pi settings and `/model`, and authenticate through Pi. Reducer consent and request accounting remain independent. See [runtime compatibility policy](pi-compatibility.md).\n'));
  edit('docs/pi-compatibility.md', text => text.replace(/## Compaction Model\n[\s\S]*?(?=\n## |$)/, '## Compaction Model\n\nThis Wardrobe preset uses native Pi compaction and model selection. Configure models and authentication through Pi. Model policy adapters are excluded from the enabled resources; their source and compatibility canaries are retained as upstream maintenance references.\n'));
  edit('global/extensions/sol-pi.ts', text => {
    text = text.replace('  provider: string;\n  model: string;\n', '');
    text = text.replace(/^\s+provider: manifest\.solPi\.reducerPolicy\?\.provider.*\n/gm, '')
      .replace(/^\s+model: manifest\.solPi\.reducerPolicy\?\.model.*\n/gm, '')
      .replace(/^\s+provider: "cpa",\n/gm, '').replace(/^\s+model: "gemini-3.8-flash-high",\n/gm, '');
    text = text.replace('  const authorizedRoute = `${policy.reducerPolicy.provider}/${policy.reducerPolicy.model}`;\n', '');
    text = text.replace('    const sessionId = ctx.sessionManager.getSessionId();\n    let usage: any;',
      '    const sessionId = ctx.sessionManager.getSessionId();\n    const authorizedRoute = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "pi/current";\n    let usage: any;');
    text = text.replace('      get(target, key) {\n        if (key === "complete")',
      '      get(target, key) {\n        // This proxy belongs only to the reducer. Resolve through Pi\'s current\n        // model on every tool result, including after a native /model change.\n        if (key === "find") return () => ctx.model;\n        if (key === "complete")');
    text = text.replace("is not authorized by manifest policy", "does not match Pi's current model");
    text = text.replace('    reducerProvider: ctxConfig.evidencePreservingReducerProvider,\n    reducerModel: ctxConfig.evidencePreservingReducerModel,',
      '    reducerProvider: "pi",\n    reducerModel: "current",');
    text = text.replace('    const authorizedRoute = `${policy.reducerPolicy.provider}/${policy.reducerPolicy.model}`;', '    const authorizedRoute = "pi/current";');
    const start = text.indexOf('    if (config.evidencePreservingReducer) {\n      const configuredRoute');
    if (start !== -1) {
      const end = text.indexOf('    const currentGeneration', start);
      text = text.slice(0, start) + text.slice(end);
    }
    return text;
  });
  edit('global/extensions/command-palette.ts', text => {
    text = text.replace(/^.*value: "compaction-model".*\n/gm, '');
    const start = text.indexOf('    if (chosenSetting === "compaction-model")');
    if (start !== -1) text = text.slice(0, start) + text.slice(text.indexOf('    if (["mcp-key"', start));
    text = text.replace('        const manifestPath = join(getAgentDir(), "manifest.json");\n        const { readFile } = await import("node:fs/promises");\n        const policy = JSON.parse(await readFile(manifestPath, "utf8")).solPi.reducerPolicy;\n        const route = `${policy.provider}/${policy.model}`;',
      '        if (!ctx.model) throw new Error("Choose a model in Pi first");\n        const route = `${ctx.model.provider}/${ctx.model.id}`;');
    return text;
  });
  for (const name of ['sol-pi-consent.mjs', 'sol-pi-phase.mjs']) {
    edit('global/extensions/' + name, text => text.replaceAll('cpa/gemini-3.8-flash-high', 'pi/current'));
  }
  edit('scripts/ticket-worker.mjs', text => text.replace('model: "cpa/gemini-3.8-flash-high",', 'model: null,').replace('      "--model", args.model,', '      ...(args.model ? ["--model", args.model] : []),'));
  edit('scripts/tmux-tickets.mjs', text => text.replace('model = "cpa/gemini-3.8-flash-high"', 'model = null').replace('"--model", model,', '...(model ? ["--model", model] : []),').replace('Subagent model (default: cpa/gemini-3.8-flash-high)', 'Optional Pi model override (default: Pi native selection)').replace('getOpt("--model", "cpa/gemini-3.8-flash-high")', 'getOpt("--model", null)'));
  // Keep the bundled native canaries aligned with the adapted runtime contract.
  edit('sol-pi-lifecycle.test.mjs', text => {
    text = text.replace('const ctx = { sessionManager: manager,', 'const ctx = { model, sessionManager: manager,');
    if (!text.includes('const selectedModels = []')) {
      text = text.replace('let handler, prompts = 0, requests = 0;', 'let handler, prompts = 0, requests = 0;\n  const selectedModels = [];')
        .replace('modelRegistry: { complete: async () => { requests++;', 'modelRegistry: { find: () => model, complete: async selected => { selectedModels.push(selected); requests++;')
        .replace('await context.modelRegistry.complete(model, {},', 'await context.modelRegistry.complete(context.modelRegistry.find("unused", "unused"), {},')
        .replace('return { ctx, manager, controller, register,', 'return { ctx, manager, controller, register, selectedModels,');
    }
    if (!text.includes('reducer follows Pi model changes')) text += `
test("reducer follows Pi model changes and requests consent for the new route", async () => {
  const f = fixture();
  await f.run();
  f.ctx.model = { provider: "pi-user", id: "chosen" };
  await f.run();
  assert.deepEqual(f.selectedModels, [model, f.ctx.model]);
  assert.equal(f.prompts, 2);
});
`;
    return text;
  });
  edit('sol-pi.test.mjs', text => {
    text = text.replace('authorizeReducer(manager.getSessionId());', 'authorizeReducer(manager.getSessionId(), `${faux.getModel().provider}/${faux.getModel().id}`);');
    text = text.replace('if (model.provider !== "cpa")', 'if (model.provider !== "cpa" && model.provider !== faux.getModel().provider)');
    const start = text.indexOf('test("reducer rejects unauthorized route specified in project sol-pi.json"');
    if (start !== -1) {
      const end = text.indexOf('test("telemetry entries', start);
      text = text.slice(0, start) + `test("legacy project reducer routes cannot change Pi model selection", async t => {
  const f = await scenario(t, {
    responses: [fauxAssistantMessage("complete")],
    config: { evidencePreservingReducer: true, evidencePreservingReducerProvider: "unauthorized-provider", evidencePreservingReducerModel: "unauthorized-model" },
  });
  assert.equal(f.session.model.provider, f.faux.getModel().provider);
});
` + text.slice(end);
    }
    return text;
  });
  edit('extension-ui.test.mjs', text => {
    text = text.replace('[[2, "/mcp-key"], [3, "/mcp"], [4, "/mcp-setup"]]', '[[1, "/mcp-key"], [2, "/mcp"], [3, "/mcp-setup"]]');
    const start = text.indexOf('test("palette settings opens global compaction model command"');
    if (start !== -1) {
      const end = text.indexOf('test("question selection', start);
      text = text.slice(0, start) + `test("palette settings delegates model configuration to native Pi settings", async () => {
  const ui = uiContext({ scripts: [choosePalette(14), [key.enter]] });
  await runPalette(ui);
  assert.deepEqual(ui.messages, []);
  assert.equal(ui.ctx.ui.getEditorText(), "/settings");
});

` + text.slice(end);
    }
    return text;
  });
}
