// Observing what a revision actually loads, in a real Pi process.
//
// Generated settings say what a revision intends. They do not say that Pi
// resolved the packages, found the resources, registered the commands, or
// accepted the tool selection. This module starts a real, short-lived Pi
// against a revision's own agent directory in RPC mode, asks it what it loaded,
// and exits it again.
//
// It observes; it never activates anything itself, never writes outside the
// directory it was pointed at, and never claims about a process it did not
// start. Where an observation cannot decide a question — an extension that
// registers no command, a theme — it says so rather than reporting absence.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { dispatchPiCommand } from "./proc.mjs";

/** How long a probe may take before it is treated as a failed startup. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Resource kinds whose loading Pi exposes as a command. */
const OBSERVABLE_KINDS = new Set(["skills", "prompts"]);

/**
 * What this revision loads right now.
 *
 * @param {{cli: string, agentDir: string, sessionDir: string, env: object,
 *   cwd?: string, timeoutMs?: number, args?: string[]}} input
 */
export async function probeLoadedState({
  cli,
  agentDir,
  sessionDir,
  env,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  args = [],
}) {
  // `--mode rpc` speaks the protocol on stdio; `--no-session` keeps the probe
  // from writing a session of its own. Callers may provide explicit skill paths
  // to resolve collisions; the default observes the revision's own settings.
  const probeArgs = ["--mode", "rpc", "--no-session", "--session-dir", sessionDir, ...args];
  const [spawnFile, spawnArgs] = dispatchPiCommand(cli, probeArgs);
  const child = spawn(
    spawnFile,
    spawnArgs,
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, PI_CODING_AGENT_DIR: agentDir },
      ...(cwd ? { cwd } : {}),
    }
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const closed = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  // One reader for the whole stream. A protocol record is framed by newlines
  // only, and a record large enough to arrive in several chunks — `get_state`
  // carries a whole model definition — must be reassembled before it is parsed.
  const reader = readLines(child, closed);

  // `get_state` is a handshake, not a question: it answers once the runtime is
  // up, which is when extensions have finished registering. Only the requests
  // are awaited here: the child exits after its stdin is closed, which happens
  // next.
  const [, commandsRow] = await Promise.all([
    reader.request("get_state"),
    reader.request("get_commands"),
  ]);
  clearTimeout(timer);

  // Closing stdin asks Pi to shut down cleanly. A probe never leaves a process
  // of its own behind, and if it will not go, it is killed rather than waited on.
  child.stdin.end();
  const exit = await Promise.race([closed, delay(5_000).then(() => ({ code: null, signal: null }))]);
  if (exit.code === null && exit.signal === null && !exit.error) child.kill("SIGKILL");

  return {
    ok: !timedOut && commandsRow?.success === true,
    commands: commandsRow?.success === true ? (commandsRow.data?.commands ?? []) : [],
    exitCode: exit.code ?? null,
    signal: exit.signal ?? null,
    stderr: stderr.trim(),
    timedOut,
    reason: describeFailure({ timedOut, timeoutMs, commandsRow, exit }),
  };
}

/**
 * A minimal JSONL reader.
 *
 * Only LF separates records. A record is parsed once its terminating newline
 * has arrived, and each response goes to the request that named its id. When
 * the child exits, every outstanding request resolves to nothing rather than
 * waiting for an answer that can no longer arrive.
 */
function readLines(child, closed) {
  let buffer = "";
  const waiting = new Map();
  let ended = false;

  const end = () => {
    if (ended) return;
    ended = true;
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        // Not a protocol record; diagnostics belong on stderr.
        continue;
      }
      const resolve = waiting.get(row?.id);
      if (!resolve) continue;
      waiting.delete(row.id);
      resolve(row);
    }
  });
  child.on("close", end);
  closed.then(end);

  return {
    request(type) {
      if (ended) return Promise.resolve(null);
      const id = `wardrobe-${type}`;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ id, type })}\n`, () => {});
      });
    },
  };
}

function describeFailure({ timedOut, timeoutMs, commandsRow, exit }) {
  if (exit.error) return `Pi could not be started: ${exit.error.message}`;
  if (timedOut) return `Pi did not answer within ${timeoutMs}ms`;
  if (commandsRow === null) return `Pi exited (${exit.code ?? exit.signal ?? "?"}) before answering`;
  if (commandsRow.success === false) return commandsRow.error ?? "Pi refused the request";
  return null;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
}

/**
 * Compare what the plan selected with what Pi loaded.
 *
 * A selected skill or prompt that produced no command, and a name registered by
 * more than one resource, are both reported. An extension or theme that
 * registers nothing cannot be observed this way, so it is listed as unobserved
 * rather than as missing — the difference matters, because "not there" is a
 * claim and "not visible from here" is not.
 */
export function reconcileSelection({ plan, commands, resourceRoots = {} }) {
  const selected = selectedResourcesOf(plan);
  const observable = selected.filter((entry) => OBSERVABLE_KINDS.has(entry.kind));
  const unobservable = selected.filter((entry) => !OBSERVABLE_KINDS.has(entry.kind));

  const pathOf = (command) => command.sourceInfo?.path ?? null;
  const matches = (entry, path) => {
    const root = resourceRoots[entry.package];
    return typeof path === 'string' && Boolean(root) && canonicalPath(path) === canonicalPath(resolve(root, entry.path));
  };
  const missing = observable.filter(
    (entry) => !commands.some((command) => matches(entry, pathOf(command)))
  );

  const byName = new Map();
  for (const command of commands) {
    const existing = byName.get(command.name);
    if (existing) existing.push(command);
    else byName.set(command.name, [command]);
  }
  const collisions = [...byName.entries()]
    .filter(([, entries]) => new Set(entries.map((entry) => pathOf(entry))).size > 1)
    .map(([name, entries]) => ({
      name,
      registeredBy: entries.map((entry) => ({
        path: pathOf(entry),
        origin: entry.sourceInfo?.origin ?? null,
        kind: entry.source ?? null,
      })),
    }));

  // A positive observation for the rest: did anything come from that file?
  const loadedPaths = new Set(commands.map(pathOf).filter(Boolean));
  const loaded = unobservable.filter((entry) =>
    [...loadedPaths].some((path) => matches(entry, path))
  );

  return {
    missing,
    collisions,
    unobserved: unobservable.filter((entry) => !loaded.includes(entry)),
    observedLoading: loaded.map((entry) => entry.path),
    selected,
    commandCount: commands.length,
  };
}

function canonicalPath(path) {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

/** Every resource the approved plan selected, as package-relative paths. */
export function selectedResourcesOf(plan) {
  return (plan?.resourceSelectors ?? []).flatMap((selector) =>
    (selector.loaded ?? []).map((path) => ({
      package: selector.package,
      kind: selector.kind,
      path,
    }))
  );
}
