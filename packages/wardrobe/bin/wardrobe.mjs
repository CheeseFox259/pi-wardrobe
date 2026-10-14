#!/usr/bin/env node
// The standalone Wardrobe launcher.
//
//   wardrobe run <revision> [args…]   start a verified revision in a new process
//     --agent-dir <path>  the directory whose revisions this is about
//     --session <path>    use this session directory instead of the revision's
//     --resume <path>     continue a session Pi already persisted
//     --no-probe          start without observing the revision first (debugging)
//   wardrobe use <revision>           print the launch plan and start nothing
//
// Reading a revision's state is `/wardrobe status` and `/wardrobe doctor` inside
// Pi. This command starts things and prints plans; it is not a second
// implementation of the inspection surface.
//
// The revision has its own agent directory, and this process is only the thing
// that starts it. Nothing outside the revision is written, and nothing from the
// user's directory is read into it.
//
// The manager's own directory must be named — `--agent-dir`, or
// `WARDROBE_AGENT_DIR` — and `PI_CODING_AGENT_DIR` is deliberately not
// accepted. Inheriting that variable would mean guessing which directory the
// caller meant, and inside a Pi session it names the caller's personal
// directory, where this manager has no business launching anything. `wardrobe
// use` is the command to run from inside a session: it starts nothing.

import { WardrobeDiagnostic, WardrobeError, describeFailure } from "../src/diagnostics.mjs";
import { integrateDisable, integrateEnable } from "../src/integrate.mjs";
import { launchPlanOf, preflightLaunch, runRevision } from "../src/launch.mjs";
import { isStale, leaseReason, LeaseStore } from "../src/lease.mjs";
import { runInteractiveSelector } from "../src/selector.mjs";

const COMMANDS = ["run", "use", "integrate"];

/**
 * One invocation of the launcher, as a function so it can be driven and checked
 * without a process boundary.
 *
 * Its streams are parameters rather than globals because the outcome a caller
 * needs is an exit status: `run` returns Pi's own, every refusal is non-zero,
 * and a plan writes JSON a caller can read.
 */
async function main(
  argv,
  {
    env = process.env,
    stderr = process.stderr,
    stdout = process.stdout,
    stdin = process.stdin,
  } = {}
) {
  const tokens = [...argv];
  const { positional, flags } = parseArgs(tokens);
  const command = positional.shift();

  if (!command) {
    if (!stdin.isTTY) {
      stderr.write(
        "wardrobe: interactive startup selector requires a TTY\n" +
          "  to run non-interactively, specify a revision:\n" +
          "  wardrobe run <revision> [--agent-dir <path>]\n"
      );
      return 1;
    }
    const agentDir = resolveAgentDir(flags, env);
    if (!agentDir) return explainNoAgentDir(stderr);
    return runSelector({ agentDir, positional, flags, env, stdin, stdout, stderr });
  }

  if (!COMMANDS.includes(command)) {
    stderr.write(
      `unknown wardrobe command ${JSON.stringify(command)}\navailable: ${COMMANDS.join(", ")}\n`
    );
    return 2;
  }

  if (command === "integrate") {
    const sub = positional.shift();
    const dir = flagValue(flags, "dir");
    const realPi = flagValue(flags, "real-pi") ?? flagValue(flags, "pi");
    const agentDir = resolveAgentDir(flags, env);
    if (sub === "enable") {
      return integrateEnable({ dir, realPi, agentDir, env, stdout, stderr });
    }
    if (sub === "disable") {
      return integrateDisable({ dir, stdout, stderr });
    }
    stderr.write(
      `unknown integrate subcommand ${JSON.stringify(sub)}\n` +
        "available: enable, disable\n"
    );
    return 2;
  }

  if (command === "run") {
    const selector = positional.shift();
    if (!selector) {
      stderr.write("wardrobe run needs a revision\nsee /wardrobe status inside Pi\n");
      return 2;
    }
    return run(selector, positional, flags, { env, stderr });
  }

  const agentDir = resolveAgentDir(flags, env);
  if (!agentDir) return explainNoAgentDir(stderr);
  // The slash commands answer about this agent directory, and nothing else.
  const scoped = { ...env, PI_CODING_AGENT_DIR: agentDir, WARDROBE_PI_CLI: env.WARDROBE_PI_CLI };
  if (command === "use") {
    const selector = positional.join(" ");
    if (!selector) {
      stderr.write("wardrobe use needs a revision\nsee: wardrobe status\n");
      return 2;
    }
    const prepared = await preflightLaunch({
      agentDir,
      selector,
      env: scoped,
      runId: `plan-${Date.now().toString(36)}`,
      sessionPath: flagValue(flags, "session"),
    });
    // The same refusal the slash command makes, from the same place: a lease
    // that cannot be read is held, not absent.
    const held = new LeaseStore(agentDir).read(prepared.report.revision);
    if (held && !isStale(held)) {
      stderr.write(
        `wardrobe: revision ${prepared.report.revision} is busy\n` +
          `  - ${leaseReason(held)}\n` +
          "  - a launch plan for a busy revision would be a plan nobody can follow\n"
      );
      return 1;
    }
    const plan = launchPlanOf({
      report: prepared.report,
      plan: prepared.plan,
      sessionDir: prepared.sessionDir,
      agentDir,
    });
    stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
}

async function executeLaunch({
  agentDir,
  selector,
  args = [],
  flags,
  env,
  stderr,
  resume = null,
}) {
  try {
    const record = await runRevision({
      agentDir,
      selector,
      args,
      env: { ...env, PI_CODING_AGENT_DIR: agentDir },
      sessionPath: flagValue(flags, "session"),
      cwd: flagValue(flags, "cwd") ?? process.cwd(),
      resume: resume ?? flagValue(flags, "resume"),
      probe: flags.get("no-probe") !== true,
    });
    // Preflight findings are reported even on a clean exit: a launched
    // revision with an unmet requirement is not the same as a silent one.
    for (const entry of record.diagnostics) {
      stderr.write(`wardrobe: ${entry.path}: ${entry.reason}\n`);
    }
    return record.exitCode ?? (record.signal ? 128 + signalNumber(record.signal) : 1);
  } catch (error) {
    if (error instanceof WardrobeError) {
      stderr.write(`${error.format()}\n`);
      return 1;
    }
    stderr.write(`wardrobe: ${error?.message ?? error}\n`);
    return 1;
  }
}

async function runSelector({ agentDir, positional, flags, env, stdin, stdout, stderr }) {
  const chosen = await runInteractiveSelector({ agentDir, env, stdin, stdout, stderr });
  if (chosen.action === "cancel") {
    return chosen.exitCode ?? 0;
  }
  return executeLaunch({
    agentDir,
    selector: chosen.presetKey ?? chosen.report.revision,
    args: positional,
    flags,
    env,
    stderr,
    resume: chosen.resume,
  });
}

async function run(selector, rest, flags, { env, stderr }) {
  const agentDir = resolveAgentDir(flags, env);
  if (!agentDir) return explainNoAgentDir(stderr);
  return executeLaunch({
    agentDir,
    selector,
    args: rest,
    flags,
    env,
    stderr,
  });
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 }[signal] ?? 0;
}

/**
 * The agent directory whose revisions this invocation is about.
 *
 * Only ever named, never inferred: `PI_CODING_AGENT_DIR` is inherited by every
 * process Pi starts, so accepting it would mean launching against the caller's
 * own environment whenever the launcher was run from inside a session.
 */
function resolveAgentDir(flags, env) {
  return (
    flagValue(flags, "agent-dir") ??
    flagValue(flags, "agentDir") ??
    env.WARDROBE_AGENT_DIR ??
    null
  );
}

function explainNoAgentDir(stderr) {
  stderr.write(
    "wardrobe needs to be told which agent directory holds its revisions\n" +
      "  pass --agent-dir <path>, or set WARDROBE_AGENT_DIR\n" +
      "  PI_CODING_AGENT_DIR is not used: inside a Pi session it names your own\n" +
      "  directory, and this manager never launches into that\n"
  );
  return 2;
}

function flagValue(flags, name) {
  const value = flags.get(name);
  return typeof value === "string" ? value : null;
}

/**
 * `--flag value`, `--flag`, and `--` to hand the rest to the child.
 *
 * WHY: Differs deliberately from commands.mjs parseArgs: CLI requires `--`
 * separator handling to pass remaining arguments through to the child Pi process
 * without parsing them as Wardrobe flags.
 */
function parseArgs(tokens) {
  const positional = [];
  const flags = new Map();
  let passthrough = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (passthrough) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      // Everything after this belongs to the child, not to Wardrobe.
      passthrough = true;
      continue;
    }
    if (token.startsWith("--")) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(token.slice(2), true);
      } else {
        flags.set(token.slice(2), next);
        index += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

export { main, parseArgs, resolveAgentDir };

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("bin/wardrobe.mjs") || process.argv[1].endsWith("wardrobe.mjs"));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code ?? 0);
    },
    (error) => {
      process.stderr.write(`${describeFailure(error instanceof WardrobeError ? error : WardrobeError.from(String(error?.message ?? error), [new WardrobeDiagnostic({ path: "", reason: "unhandled failure" })]))}\n`);
      process.exit(1);
    }
  );
}
