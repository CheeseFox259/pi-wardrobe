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

// A provider that answers locally and needs no credential.
//
// Real Pi refuses to run a turn without a model, so a check that wants to
// observe what a session actually does — the prompt it would send, the tools it
// declares, a conversation that persists and can be resumed — needs a model
// that exists. This one is registered by the driver extension and streams a
// fixed reply, so nothing here reaches a network.
const LOCAL_PROVIDER = "wardrobe-local";
const LOCAL_MODEL = "fixture-local";
const LOCAL_REPLY = "fixture reply";
// A placeholder, not a credential. Pi refuses to select a model whose provider
// has no key at all, and this provider streams a fixed reply from this process,
// so nothing is ever sent to the address below.
const LOCAL_PLACEHOLDER_KEY = "fixture-local-no-network";
const LOCAL_PLACEHOLDER_URL = "http://127.0.0.1/never-used";

const localModel = {
  // A full Model, not only a provider model config: selecting it is done with
  // pi.setModel(), which resolves a model by identity rather than by name.
  provider: LOCAL_PROVIDER,
  api: "anthropic-messages",
  id: LOCAL_MODEL,
  name: "Fixture Local",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  // Pi reads a model's thinking levels from this map; a model that declares
  // none is treated as supporting none, and asking for one fails at request
  // time rather than at selection time.
  thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/**
 * The text of a message, whichever shape it arrives in.
 *
 * A system message arrives with an empty content string and its real prompt in
 * named sections — the preamble, the tool listing, appended guidelines — so
 * reading only content would report an empty prompt and hide everything worth
 * checking.
 */
const textOf = (message) => {
  if (!message) return null;
  const parts = [];
  if (typeof message.content === "string" && message.content) parts.push(message.content);
  if (Array.isArray(message.content)) {
    parts.push(
      message.content.map((block) => (typeof block === "string" ? block : (block?.text ?? ""))).join(""),
    );
  }
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    if (typeof value === "string" && value) parts.push(name + ":\\n" + value);
    else if (value && typeof value === "object") parts.push(name + ":\\n" + JSON.stringify(value));
  }
  return parts.length === 0 ? (typeof message.content === "string" ? message.content : "") : parts.join("\\n\\n");
};

/**
 * Answer one request locally, shaped the way Pi's providers do.
 *
 * What arrives here is recorded: the system prompt the session built, the tools
 * it declared, the reasoning level it asked for. That is how a check observes
 * effective prompt and tool state without a network call — at the model
 * boundary, not at the settings that produced it.
 *
 * The return value is a stream Pi can consume: an iterator over the events plus
 * the final message it waits on. A bare async generator is not enough, because
 * the agent loop asks a stream for its result as well as its events.
 */
const localStream = (model, context, options) => {
  const system = (context?.messages ?? []).find((message) => message.role === "system");
  appendFileSync(
    join(process.env.PI_CODING_AGENT_DIR, "fixture-request.jsonl"),
    JSON.stringify({
      model: model.provider + "/" + model.id,
      systemPrompt: textOf(system),
      // This API declares a session's tools in the system prompt rather than as
      // an option, so the prompt is where a check must look for them.
      tools: (options?.tools ?? []).map((tool) => tool?.name ?? String(tool)),
      reasoning: options?.reasoning ?? null,
      messageRoles: (context?.messages ?? []).map((message) => message.role),
    }) + "\\n",
  );
  const message = {
    role: "assistant",
    content: [{ type: "text", text: LOCAL_REPLY }],
    api: "anthropic-messages",
    provider: model.provider,
    model: model.id,
    usage: { ...usage },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: { ...message, content: [] } },
    { type: "text_start", contentIndex: 0, partial: { ...message, content: [] } },
    { type: "text_delta", contentIndex: 0, delta: LOCAL_REPLY, partial: { ...message, content: [] } },
    { type: "text_end", contentIndex: 0, content: LOCAL_REPLY, partial: message },
    { type: "done", reason: "stop", message },
  ];
  let next = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          next < events.length
            ? { value: events[next++], done: false }
            : { value: undefined, done: true },
      };
    },
    result: async () => message,
    push: () => {},
    end: () => {},
  };
};

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
    handler: async (_args, ctx) => {
      // What is in effect right now, not what was requested: the active tools,
      // the thinking level and the prompt the next model request would carry.
      // allTools separates a tool that is registered but not active from one
      // that does not exist here at all.
      const state = {
        tools: pi.getActiveTools(),
        allTools: pi.getAllTools().map((tool) => tool.name),
        loads: globalThis.__wardrobeFixtureLoads ?? 0,
        thinkingLevel: ctx.thinkingLevel ?? null,
        model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : null,
        systemPrompt: ctx.getSystemPrompt(),
      };
      appendFileSync(statePath(), JSON.stringify(state) + "\\n");
    },
  });
  // Select the local model. Pi resolves --provider and --model before
  // extensions load, so a provider an extension registers cannot be named on
  // the command line. Registering it here rather than at load also matters: a
  // registration made during load is queued until the runner binds, and a
  // second extension loading afterwards can leave that registration unapplied.
  // A failed turn reports a message but no stack. Capturing one here is the
  // only way a check can tell a manager bug from a Pi defect.
  pi.on("agent_end", (event) => {
    if (!event?.error) return;
    appendFileSync(
      join(process.env.PI_CODING_AGENT_DIR, "fixture-error.txt"),
      (event.error?.stack ?? String(event.error)) + "\\n",
    );
  });

  pi.registerCommand("fixture-use-local", {
    handler: async (_args, ctx) => {
      pi.registerProvider(LOCAL_PROVIDER, {
        api: "anthropic-messages",
        baseUrl: LOCAL_PLACEHOLDER_URL,
        apiKey: LOCAL_PLACEHOLDER_KEY,
        models: [localModel],
        streamSimple: localStream,
      });
      const chosen = await pi.setModel(localModel);
      const registry = ctx.modelRegistry;
      writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR, "fixture-model.txt"),
        JSON.stringify({
          chosen: chosen === true,
          provider: Boolean(registry?.getProvider?.(LOCAL_PROVIDER)),
          auth: registry?.getProviderAuthStatus?.(LOCAL_PROVIDER) ?? null,
          hasAuth: registry?.hasConfiguredAuth?.(localModel) ?? null,
          found: Boolean(registry?.find?.(LOCAL_PROVIDER, LOCAL_MODEL)),
        }),
      );
    },
  });
  pi.registerCommand("fixture-prompt", {
    handler: async (_args, ctx) => {
      writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR, "fixture-prompt.txt"),
        ctx.getSystemPrompt(),
      );
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
