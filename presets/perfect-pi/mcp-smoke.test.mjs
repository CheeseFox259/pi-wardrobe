import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { smokeManagedMcp } from './scripts/check-managed-mcp.mjs';

// Pi is the external transport boundary. The real-transport smoke is exercised
// separately; this fixture makes the account-daemon admission error deterministic.
test('a blocked account daemon does not hide another server result or report a full pass', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'extensions/mcp'), { recursive: true });
  writeFileSync(join(dir, 'extensions/mcp/runtime.js'), `
export class McpOAuthCredentialStore {}
export function createDefaultTransport() {}
export class McpServerConnection {
  constructor({entry}) { this.name=entry.name; this.tools=[{name:'ctx_index'},{name:'ctx_search'},{name:'unsafe_new_tool'}]; }
  async getClient() { if(this.name==='codebase-memory')throw new Error('CBM could not start because the active account daemon uses a different cache directory'); return {serverInfo:{version:'1.0.169'}}; }
  async callTool(name) { return {content:[{type:'text',text:name==='ctx_search'?'73 milliseconds':'indexed'}]}; }
  async close() {}
}`);
  writeFileSync(join(dir, 'extensions/mcp/config.js'), `export function getMcpToolExposure(config,name) {return config.toolExposure[name]||config.toolExposure['*'];}`);
  const manifest = { mcpServers: {
    'codebase-memory': { package:'codebase-memory-mcp@0.11.0', tools:['index_repository'], dataEnv:'CBM_CACHE_DIR' },
    'context-mode': { package:'context-mode@1.0.169', tools:['ctx_index','ctx_search'], dataEnv:'CONTEXT_MODE_DATA_DIR' },
  }};
  const report = await smokeManagedMcp(manifest, {runtime:{entry:join(dir,'index.js')}, prepare:false});
  assert.equal(report.ok, false);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].state, 'blocked');
  assert.equal(report.results[0].code, 'daemon-cache-conflict');
  assert.equal(report.results[1].state, 'passed');
  assert.deepEqual(report.results[1].operations, ['ctx_index','ctx_search']);
  assert.equal(report.state, 'blocked');
  assert.ok(report.evidenceDir);
  rmSync(report.evidenceDir, {recursive:true,force:true});
});

test('server selection and preparation mode refuse empty or unverified success', async () => {
  const manifest = {mcpServers:{'context-mode':{package:'context-mode@1.0.169'}}};
  await assert.rejects(smokeManagedMcp(manifest,{server:'missing'}),/Unknown managed server/);
  await assert.rejects(smokeManagedMcp(manifest,{prepareOnly:true,prepare:false}),/Cannot skip/);
  await assert.rejects(smokeManagedMcp({mcpServers:{}}),/No managed servers/);
});
