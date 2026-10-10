// Real Pi process control: CLI invocations and NDJSON RPC sessions.
//
// Nothing here mocks the installer or the resource loader. Every assertion is
// made against a real Pi process running against the loopback fixtures.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "./fsx.mjs";

const RPC_BASE_ARGS = [
  "--mode",
  "rpc",
  "--offline",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
];

export class PiRunner {
  constructor({ sandbox, runtime }) {
    this.sandbox = sandbox;
    this.runtime = runtime;
    this.driverPath = join(sandbox.work, "rpc-driver.mjs");
  }

  #env(agentName, extra) {
    return this.sandbox.childEnv({
      agentDir: this.sandbox.agentPath(agentName),
      extra,
    });
  }

  async run(agentName, args, { extraEnv, timeoutMs } = {}) {
    return this.sandbox.runner.run(process.execPath, [this.runtime.cliPath, ...args], {
      cwd: this.sandbox.project,
      env: this.#env(agentName, extraEnv),
      timeoutMs,
    });
  }

  /** Run a Pi command that must succeed; surface stderr when it does not. */
  async runOk(agentName, args, options) {
    const result = await this.run(agentName, args, options);
    if (result.code !== 0) {
      throw new Error(
        `pi ${args.join(" ")} exited ${result.code}\n${result.stderr}\n${result.stdout}`
      );
    }
    return result;
  }

  async npmVersion() {
    const result = await this.sandbox.runner.run("npm", ["--version"], {
      cwd: this.sandbox.project,
      env: this.sandbox.childEnv(),
    });
    return result.stdout.trim();
  }

  /** Write the RPC driver: it activates or deactivates the fixture extension. */
  ensureDriver() {
    if (existsSync(this.driverPath)) return this.driverPath;
    writeFileSync(this.driverPath, DRIVER_SOURCE);
    return this.driverPath;
  }

  async rpc(agentName, { sessionFile, extraArgs = [], extraEnv } = {}) {
    const driver = this.ensureDriver();
    const args = [...RPC_BASE_ARGS, "-e", driver];
    if (sessionFile) args.push("--session", sessionFile);
    else args.push("--no-session");
    const child = this.sandbox.runner.fork(process.execPath, [this.runtime.cliPath, ...args], {
      cwd: this.sandbox.project,
      env: this.#env(agentName, extraEnv),
    });
    const session = new RpcSession(child, this.sandbox.runner, {
      agentName,
      agentDir: this.sandbox.agentPath(agentName),
      eventsLog: this.sandbox.extensionLog,
    });
    // Extensions load asynchronously after startup. Without this handshake the
    // first request can arrive before they are registered, and a command sent
    // through the prompt channel would then be treated as model input.
    await session.request("get_state");
    return session;
  }
}

export class RpcSession {
  #child;
  #runner;
  #pending = new Map();
  #buffer = "";
  #seq = 0;
  #stderr = "";
  #exited;
  #eventOffset = 0;

  constructor(child, runner, { agentName, agentDir, eventsLog }) {
    this.#child = child;
    this.#runner = runner;
    this.agentName = agentName;
    this.agentDir = agentDir;
    this.eventsLog = eventsLog;
    // The log is shared by every session in one harness; a session only owns
    // the events appended after it started.
    this.#eventOffset = readJsonl(eventsLog).length;
    child.stderr.on("data", (chunk) => (this.#stderr += chunk));
    child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#exited = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        for (const { reject } of this.#pending.values()) {
          reject(new Error(`RPC session exited (${code ?? signal}) before replying\n${this.#stderr}`));
        }
        this.#pending.clear();
        resolve({ code, signal });
      });
    });
  }

  get stderr() {
    return this.#stderr;
  }

  #consume(chunk) {
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = this.#pending.get(row.id);
      if (row.type === "response" && waiter) {
        this.#pending.delete(row.id);
        waiter.resolve(row);
      }
    }
  }

  request(type, data = {}) {
    const id = `fixture-${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC request ${type} timed out\n${this.#stderr}`));
      }, 30_000);
      this.#pending.set(id, {
        resolve: (row) => {
          clearTimeout(timer);
          resolve(row);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    });
  }

  /** Invoke a registered slash command through the real prompt channel. */
  async command(name) {
    const row = await this.request("prompt", { message: `/${name}` });
    if (!row.success) {
      throw new Error(`RPC command /${name} failed: ${JSON.stringify(row)}`);
    }
    return row;
  }

  async commandNames() {
    const row = await this.request("get_commands");
    return (row.data?.commands ?? []).map((entry) => entry.name);
  }

  /** Observations the driver extension appended for this agent directory. */
  extensionStates() {
    return readJsonl(join(this.agentDir, "fixture-state.jsonl"));
  }

  /** Fixture-extension lifecycle events appended during this session. */
  extensionEvents() {
    return readJsonl(this.eventsLog).slice(this.#eventOffset);
  }

  /** Custom session entries the manager or driver appended. */
  customEntries(customType) {
    const path = join(this.agentDir, "fixture-entries.json");
    if (!existsSync(path)) return [];
    const entries = JSON.parse(readFileSync(path, "utf8"));
    return customType ? entries.filter((entry) => entry.customType === customType) : entries;
  }

  /** Ask the driver to snapshot the current custom entries, then read them. */
  async readCustomEntries(customType) {
    await this.command("fixture-entries");
    return this.customEntries(customType);
  }

  lastExtensionState() {
    const states = this.extensionStates();
    return states.length > 0 ? states[states.length - 1] : null;
  }

  async close({ expectCleanExit = true } = {}) {
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), 10_000);
    const { code, signal } = await this.#exited;
    clearTimeout(timer);
    this.#runner.release(this.#child);
    if (expectCleanExit && code !== 0) {
      throw new Error(`RPC session exited with ${code ?? signal}\n${this.#stderr}`);
    }
    return { code, signal };
  }
}

const DRIVER_SOURCE = `import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const settingsPath = () => join(process.env.PI_CODING_AGENT_DIR, "settings.json");
const statePath = () => join(process.env.PI_CODING_AGENT_DIR, "fixture-state.jsonl");
const entriesPath = () => join(process.env.PI_CODING_AGENT_DIR, "fixture-entries.json");

const setExtensions = async (ctx, extensions) => {
  const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
  settings.packages = (settings.packages ?? []).map((entry) =>
    typeof entry === "string" ? { source: entry, extensions } : { ...entry, extensions }
  );
  writeFileSync(settingsPath(), JSON.stringify(settings));
  await ctx.waitForIdle();
  await ctx.reload();
};

export default function (pi) {
  pi.registerCommand("fixture-enable", {
    handler: async (_args, ctx) => setExtensions(ctx, ["extension.mjs"]),
  });
  pi.registerCommand("fixture-disable", {
    handler: async (_args, ctx) => setExtensions(ctx, []),
  });
  pi.registerCommand("fixture-state", {
    handler: async () => {
      const state = { tools: pi.getActiveTools(), loads: globalThis.__wardrobeFixtureLoads ?? 0 };
      appendFileSync(statePath(), JSON.stringify(state) + "\\n");
    },
  });
  pi.registerCommand("fixture-entries", {
    handler: async (_args, ctx) => {
      const custom = ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom");
      writeFileSync(entriesPath(), JSON.stringify(custom));
    },
  });
}
`;
