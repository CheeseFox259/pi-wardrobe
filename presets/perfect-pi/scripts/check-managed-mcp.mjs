#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { managedMcpConfigs, inspectManagedMcp } from "./managed-mcp.mjs";
import { detectPiRuntime } from "./pi-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const textOf = result => (result.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");

// Install/cache package code before starting Pi's fixed handshake timer. No MCP
// executable is launched here; npm still runs the pinned package's install hooks.
export function prepareMcpPackage(spec) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@\d+\.\d+\.\d+$/.test(spec)) throw new Error("Pinned package required");
  const args = ["--yes", "--prefer-offline", "--package=" + spec, process.execPath, "-e", ""];
  const windows = process.platform === "win32";
  const command = 'npx.cmd --yes --prefer-offline --package=' + spec + ' "%WARDROBE_MCP_NODE%" -e ""';
  const child = spawn(windows ? "cmd.exe" : "npx", windows ? ["/d", "/s", "/v:off", "/c", command] : args, {
    stdio: ["ignore", "ignore", "pipe"], detached: !windows,
    env: { ...process.env, WARDROBE_MCP_NODE: process.execPath },
  });
  return new Promise((done, reject) => {
    let timedOut = false;
    child.stderr.resume();
    const stop = () => { if (!windows && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } else child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 180_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Package preparation could not start")); });
    child.once("close", code => { clearTimeout(timer); if (code === 0) done(); else reject(new Error(timedOut ? "Package preparation timed out before MCP connection" : "Package preparation failed (npm exit " + code + "); check registry/build prerequisites")); });
  });
}

export async function smokeManagedMcp(manifest, { runtime: suppliedRuntime, prepare = true, prepareOnly = false, server, onProgress = () => {} } = {}) {
  const started = performance.now();
  if (prepareOnly && !prepare) throw new Error("Cannot skip preparation in prepare-only mode");
  if (!Object.keys(manifest.mcpServers || {}).length) throw new Error("No managed servers to verify");
  if (server && !manifest.mcpServers?.[server]) throw new Error("Unknown managed server: " + server);
  const runtime = suppliedRuntime ?? await detectPiRuntime();
  if (!runtime) throw new Error("Pi runtime not found");
  const base = dirname(runtime.entry);
  const { McpServerConnection, McpOAuthCredentialStore, createDefaultTransport } = await import(pathToFileURL(join(base, "extensions/mcp/runtime.js")));
  const { getMcpToolExposure } = await import(pathToFileURL(join(base, "extensions/mcp/config.js")));
  const fixture = await mkdtemp(join(tmpdir(), "perfect-pi-mcp-smoke-"));
  const project = join(fixture, "project"), agent = join(fixture, "agent");
  const results = [];
  let succeeded = false;
  try {
    await mkdir(project); await mkdir(join(agent, "scripts"), { recursive: true });
    for (const name of ["mcp-launch.mjs", "mcp-secrets.mjs"]) await cp(join(root, "scripts", name), join(agent, "scripts", name));
    await writeFile(join(project, "smoke.py"), "def audit_helper(value):\n    return value + 1\n\ndef audit_entry(value):\n    return audit_helper(value)\n");
    const configs = managedMcpConfigs(manifest, agent);
    for (const config of Object.values(configs)) {
      for (const path of Object.values(config.env)) await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: configs }));
    for (const [name, config] of Object.entries(configs).filter(([name]) => !server || name === server)) {
      const phaseStarted = performance.now();
      let preparationMs = 0;
      if (prepare) {
        onProgress(name + ": preparing pinned package cache");
        try { await prepareMcpPackage(manifest.mcpServers[name].package); preparationMs = Math.round(performance.now() - phaseStarted); }
        catch (error) { results.push({ name, state: "failed", phase: "prepare", reason: error.message, elapsedMs: Math.round(performance.now() - phaseStarted) }); continue; }
      }
      if (prepareOnly) { results.push({ name, state: "prepared", verified: "package-cache-only; no MCP connection or workload", preparationMs }); continue; }
      onProgress(name + ": native connection and functional workload");
      const entry = { name, config, source: join(agent, "mcp.json"), scope: "global" };
      const connection = new McpServerConnection({
        entry, cwd: project, credentials: new McpOAuthCredentialStore(), onTools: () => {},
        createTransport: (item, cwd, auth) => createDefaultTransport(item, cwd, auth),
      });
      const abort = new AbortController();
      const timer = setTimeout(() => { abort.abort(); void connection.close(); }, 90_000);
      try {
        const client = await connection.getClient();
        const expectedVersion = manifest.mcpServers[name].package.match(/@(\d+\.\d+\.\d+)$/)[1];
        assert.equal(client.serverInfo?.version, expectedVersion, `${name} runtime version`);
        for (const tool of manifest.mcpServers[name].tools) assert.ok(connection.tools.some(item => item.name === tool), `${name} missing ${tool}`);
        const hidden = connection.tools.filter(tool => getMcpToolExposure(config, tool.name) === "hidden").map(tool => tool.name);
        assert.equal(getMcpToolExposure(config, "new_unreviewed_tool"), "hidden");
        const call = async (tool, args) => {
          assert.equal(getMcpToolExposure(config, tool), "codemode", `Denied tool ${tool}`);
          const result = await connection.callTool(tool, args, { signal: abort.signal, timeoutMs: 45_000 });
          assert.notEqual(result.isError, true, `${name}/${tool}: ${textOf(result)}`);
          return result;
        };
        let operations;
        if (name === "context-mode") {
          await call("ctx_index", { content: "# Fixture\nThe managed_mcp_fixture_unique retry interval is 73 milliseconds.", source: "managed-smoke" });
          const found = await call("ctx_search", { queries: ["managed_mcp_fixture_unique retry"], source: "managed-smoke", limit: 3 });
          assert.match(textOf(found), /73 milliseconds/);
          operations = ["ctx_index", "ctx_search"];
        } else if (name === "codebase-memory") {
          const indexed = await call("index_repository", { repo_path: project, mode: "fast", persistence: false });
          const info = JSON.parse(textOf(indexed));
          assert.equal(info.status, "indexed"); assert.ok(info.nodes > 0);
          const found = await call("search_graph", { project: info.project, name_pattern: "audit_entry", format: "json" });
          assert.match(textOf(found), /audit_entry/);
          const traced = await call("trace_path", { project: info.project, function_name: "audit_entry", direction: "outbound", include_evidence: true });
          assert.match(textOf(traced), /audit_helper/);
          await call("check_index_coverage", { project: info.project, paths: ["smoke.py"] });
          operations = ["index_repository", "search_graph", "trace_path", "check_index_coverage"];
        } else throw new Error(`No functional workload defined for ${name}`);
        results.push({ name, state: "passed", preparationMs, elapsedMs: Math.round(performance.now() - phaseStarted), version: client.serverInfo.version, tools: connection.tools.length, allowlisted: manifest.mcpServers[name].tools.length, hidden, operations, verified: "native Pi transport and connection; temporary-fixture functional smoke" });
      } catch (error) {
        const blocked = /active account daemon uses a different cache directory/.test(error.message);
        results.push({ name, state: blocked ? "blocked" : "failed", code: blocked ? "daemon-cache-conflict" : "workload-failed", phase: "connect-or-workload", preparationMs, elapsedMs: Math.round(performance.now() - phaseStarted), reason: blocked ? "Existing CBM account daemon uses another cache root; this isolated check cannot run alongside it. No existing process or cache was changed." : error.message });
      } finally {
        clearTimeout(timer);
        await connection.close();
      }
    }
    succeeded = results.every(result => ["passed", "prepared"].includes(result.state));
    const state = results.some(r => r.state === "failed") ? "failed" : results.some(r => r.state === "blocked") ? "blocked" : prepareOnly ? "prepared" : "passed";
    const report = { ok: succeeded, state, results, elapsedMs: Math.round(performance.now() - started), ...(!succeeded ? { evidenceDir: fixture } : {}), limitations: ["Not a model-driven codemode or production-repository E2E run", "No native context-mode adapter or automatic session-memory hooks loaded", "Package top-level versions pinned; npx transitive dependencies are not lockfile-frozen"] };
    if (!succeeded) await writeFile(join(fixture, "REPORT.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  } catch (error) {
    error.message += `; temporary evidence retained at ${fixture}`;
    throw error;
  } finally { if (succeeded) await rm(fixture, { recursive: true, force: true }); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log("Usage: node scripts/check-managed-mcp.mjs [--smoke] [--server <name>] [--prepare-only] [--skip-prepare]\nDefault: config/ownership check only. --smoke prepares pinned packages before native Pi MCP workloads in temporary fixtures. --prepare-only caches packages without connecting. Partial/blocked results exit nonzero; no provider request or personal-server connection."); return; }
  let server;
  const flags = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--server") { flags.push(args[index]); continue; }
    if (server || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--server requires one name");
    server = args[++index];
  }
  if (flags.some(arg => !["--smoke", "--prepare-only", "--skip-prepare"].includes(arg))) throw new Error("Unsupported argument; use --help");
  if ((server || flags.includes("--skip-prepare")) && !flags.includes("--smoke") && !flags.includes("--prepare-only")) throw new Error("Use --smoke or --prepare-only with server selection");
  if (flags.includes("--prepare-only") && flags.includes("--skip-prepare")) throw new Error("Cannot skip preparation in prepare-only mode");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  let report;
  if (flags.includes("--smoke") || flags.includes("--prepare-only")) report = await smokeManagedMcp(manifest, { server, prepare: !flags.includes("--skip-prepare"), prepareOnly: flags.includes("--prepare-only"), onProgress: message => process.stderr.write(message + "\n") });
  else {
    const agent = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, homedir())) : join(homedir(), ".pi/agent");
    let state = {}; try { state = JSON.parse(await readFile(join(agent, ".perfect-pi-state.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const result = inspectManagedMcp(manifest, agent, state.mcpServers);
    report = { ok: result.status === "SYNCED", ...result };
  }
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : report.state === "blocked" ? 2 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
