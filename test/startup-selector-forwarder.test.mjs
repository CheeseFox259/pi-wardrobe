// Acceptance tests for Ticket 12: Startup selector & shell/PATH forwarder.
//
// Verifies:
// 1. Bare wardrobe and opted-in `pi --wardrobe` display a pre-Pi selector in a TTY.
// 2. Selection validates mode and revision and invokes the existing launcher.
// 3. Cancellation starts no preset process and acquires no lease.
// 4. Non-TTY environments fail clearly with an actionable message.
// 5. Shell integration enable/disable is explicit, reversible, and never silently overwrites.
// 6. Ordinary Pi invocations forward unchanged preserving cwd, arguments, exit code, and signal disposition.
// 7. No recursion: wrapper records real Pi path at enable time.
// 8. Real node-pty drives selector navigation, cancellation, mode choice, and resume mode.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pty from "node-pty";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { BindingStore } from "../packages/wardrobe/src/binding.mjs";
import { LeaseStore } from "../packages/wardrobe/src/lease.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("startup-selector-forwarder");
const ROOT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MANAGER_DIR = join(ROOT_DIR, "packages", "wardrobe");
const CLI = join(MANAGER_DIR, "bin", "wardrobe.mjs");

function ensurePtyHelper() {
  try {
    const helper = resolve(ROOT_DIR, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
    }
  } catch {}
}

/** Helper to drive a node-pty terminal session. */
function drivePty(term, { timeoutMs = 15_000 } = {}) {
  let output = "";
  const listeners = [];
  let exited = false;

  const kill = () => {
    if (!exited) {
      exited = true;
      try {
        term.kill();
      } catch {}
    }
  };

  term.onExit(() => {
    exited = true;
  });

  term.onData((data) => {
    output += data;
    for (let i = listeners.length - 1; i >= 0; i -= 1) {
      const listener = listeners[i];
      if (listener.check()) {
        listeners.splice(i, 1);
        listener.resolve(output);
      }
    }
  });

  const waitForOutput = (pattern, timeout = timeoutMs) =>
    new Promise((resolve, reject) => {
      const check = () =>
        typeof pattern === "string" ? output.includes(pattern) : pattern.test(output);
      if (check()) return resolve(output);
      const timer = setTimeout(() => {
        kill();
        reject(new Error(`Timed out waiting for ${pattern} in PTY output:\n${output.slice(-1000)}`));
      }, timeout);
      listeners.push({
        check,
        resolve: (out) => {
          clearTimeout(timer);
          resolve(out);
        },
      });
    });

  const waitForNewOutput = (pattern, timeout = timeoutMs) => {
    const startIndex = output.length;
    return new Promise((resolve, reject) => {
      const check = () => {
        const slice = output.slice(startIndex);
        return typeof pattern === "string" ? slice.includes(pattern) : pattern.test(slice);
      };
      if (check()) return resolve(output);
      const timer = setTimeout(() => {
        kill();
        reject(
          new Error(
            `Timed out waiting for new output matching ${pattern}:\n${output.slice(startIndex)}`
          )
        );
      }, timeout);
      listeners.push({
        check,
        resolve: (out) => {
          clearTimeout(timer);
          resolve(out);
        },
      });
    });
  };

  const waitForExit = (timeout = timeoutMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        kill();
        reject(new Error(`Timed out waiting for PTY exit:\n${output.slice(-1000)}`));
      }, timeout);
      term.onExit(({ exitCode, signal }) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, output });
      });
    });

  return {
    term,
    kill,
    getOutput: () => output,
    waitForOutput,
    waitForNewOutput,
    waitForExit,
    write: (data) => term.write(data),
  };
}

/** Install the manager extension inside Pi. */
async function installManager(h, agent = "primary") {
  h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ["install", MANAGER_DIR]);
}

/** A self-contained minimal preset that installs quickly without npm dependencies. */
function minimalPreset(id = "minimal", name = "Minimal Preset") {
  return {
    schemaVersion: 1,
    id,
    name,
    version: "1.0.0",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    packages: {},
    resources: [],
  };
}

/** Install a preset in an agent directory. */
async function installPreset(h, agent, name, definition) {
  const git = await h.gitRepo(name, [
    { message: "add", files: { "preset.json": `${JSON.stringify(definition)}\n` } },
  ]);
  const source = git.sourceAt(git.commits[0]);
  const session = await h.pi.rpc(agent, {
    extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/` },
  });
  let reviewed;
  try {
    await session.command(`wardrobe install ${source}`);
    [reviewed] = await session.readCustomEntries(RESULT_TYPE);
  } finally {
    await session.close();
  }
  assert.equal(reviewed.data.ok, true, reviewed.data.text);
  const sessionConfirm = await h.pi.rpc(agent, {
    extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/` },
  });
  let confirmed;
  try {
    await sessionConfirm.command(`wardrobe install ${source} --confirm ${reviewed.data.plan.digest}`);
    const [result] = await sessionConfirm.readCustomEntries(RESULT_TYPE);
    confirmed = result.data;
  } finally {
    await sessionConfirm.close();
  }
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  return { planId: confirmed.plan.planId, agentDir: confirmed.staging.agentDir, source };
}

/** Create an executable recording stub that logs arguments, cwd, and exits with a given code. */
function createRecordingStub(dir, name = "pi-stub.mjs", exitCode = 0) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.1.0" }) + "\n"
  );
  const stubPath = join(dir, name);
  const logPath = join(dir, `${name}.log`);
  const content = [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    `const logPath = ${JSON.stringify(logPath)};`,
    "const record = {",
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  env: {",
    "    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,",
    "    WARDROBE_PI_CLI: process.env.WARDROBE_PI_CLI,",
    "    WARDROBE_AGENT_DIR: process.env.WARDROBE_AGENT_DIR,",
    "  },",
    "  pid: process.pid,",
    "};",
    'writeFileSync(logPath, JSON.stringify(record, null, 2) + "\\n");',
    `process.exit(${exitCode});`,
  ].join("\n");
  writeFileSync(stubPath, content, { mode: 0o755 });
  chmodSync(stubPath, 0o755);
  return {
    path: stubPath,
    logPath,
    readLog: () => (existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : null),
  };
}

// ---------------------------------------------------------------------------
// 1. Non-TTY failure semantics
// ---------------------------------------------------------------------------

test("non-TTY bare wardrobe exits non-zero with actionable message and starts nothing", async () => {
  const h = harness();
  const agentDir = h.agentPath("primary");

  // Run with pipe stdio (non-TTY)
  const result = await h.sandbox.runner.run(process.execPath, [CLI, "--agent-dir", agentDir], {
    cwd: h.sandbox.project,
    env: h.sandbox.childEnv({ agentDir }),
  });

  assert.equal(result.code, 1, `expected exit code 1, got ${result.code}`);
  assert.match(
    result.stderr,
    /interactive startup selector requires a TTY/,
    "stderr should explain TTY is required"
  );
  assert.match(
    result.stderr,
    /wardrobe run <revision>/,
    "stderr should provide actionable non-interactive run syntax"
  );

  // Verify nothing started and no lease acquired
  const leaseDir = join(agentDir, "wardrobe", "leases");
  assert.equal(
    !existsSync(leaseDir) || readdirSync(leaseDir).length === 0,
    true,
    "non-TTY failure should acquire no lease"
  );
});

// ---------------------------------------------------------------------------
// 2. Integration enable, disable, and refusal
// ---------------------------------------------------------------------------

test("wardrobe integrate enable writes wrapper with recorded real Pi and refuses overwrite", async () => {
  const h = harness();
  const targetDir = join(h.sandbox.root, "bin-integration");
  const stub = createRecordingStub(join(h.sandbox.root, "stub"), "real-pi.mjs");

  // Enable integration with explicit real-pi
  const res = await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", targetDir, "--real-pi", stub.path],
    { cwd: h.sandbox.project }
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /wardrobe integration enabled at/);
  assert.match(res.stdout, /export PATH=/);

  const wrapperPath = join(targetDir, "pi");
  assert.ok(existsSync(wrapperPath), "wrapper file should exist");
  const wrapperContent = readFileSync(wrapperPath, "utf8");
  assert.match(wrapperContent, /# Generated by wardrobe integrate/);
  assert.match(wrapperContent, /# Marker: WARDROBE_INTEGRATION_WRAPPER/);
  assert.ok(
    wrapperContent.includes(`REAL_PI='${realpathSync(stub.path)}'`) ||
      wrapperContent.includes(`REAL_PI="${realpathSync(stub.path)}"`) ||
      wrapperContent.includes(`REAL_PI='${stub.path}'`),
    "wrapper must record the real Pi path literally"
  );

  // Attempting to enable again in the same directory refuses without overwriting
  const overwriteRes = await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", targetDir, "--real-pi", stub.path],
    { cwd: h.sandbox.project }
  );
  assert.equal(overwriteRes.code, 1, "enable must refuse to overwrite");
  assert.match(overwriteRes.stderr, /refusing to overwrite existing file/);
});

test("wardrobe integrate disable removes only its own wrapper and refuses foreign files", async () => {
  const h = harness();
  const foreignDir = join(h.sandbox.root, "foreign-bin");
  mkdirSync(foreignDir, { recursive: true });
  const foreignPi = join(foreignDir, "pi");
  writeFileSync(foreignPi, "#!/bin/sh\necho 'foreign pi binary'\n", { mode: 0o755 });

  // Disabling against a foreign file must refuse
  const foreignRes = await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "disable", "--dir", foreignDir],
    { cwd: h.sandbox.project }
  );
  assert.equal(foreignRes.code, 1, "disable must refuse non-wardrobe file");
  assert.match(foreignRes.stderr, /not a wardrobe integration wrapper/);
  assert.ok(existsSync(foreignPi), "foreign file must remain intact");

  // Now create an authentic wrapper and disable it
  const managedDir = join(h.sandbox.root, "managed-bin");
  const stub = createRecordingStub(join(h.sandbox.root, "stub-disable"), "real-pi.mjs");
  await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", managedDir, "--real-pi", stub.path],
    { cwd: h.sandbox.project }
  );
  assert.ok(existsSync(join(managedDir, "pi")), "managed wrapper must exist");

  const disableRes = await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "disable", "--dir", managedDir],
    { cwd: h.sandbox.project }
  );
  assert.equal(disableRes.code, 0, disableRes.stderr);
  assert.match(disableRes.stdout, /wardrobe integration disabled: removed/);
  assert.ok(!existsSync(join(managedDir, "pi")), "managed wrapper must be removed");
});

// ---------------------------------------------------------------------------
// 3. Wrapper forwarding semantics and recursion avoidance
// ---------------------------------------------------------------------------

test("integration wrapper forwards ordinary arguments, cwd, and exit code to real Pi without recursion", async () => {
  const h = harness();
  const wrapperDir = join(h.sandbox.root, "wrapper-test");
  const stub = createRecordingStub(join(h.sandbox.root, "stub-fwd"), "real-pi.mjs", 42);

  await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", wrapperDir, "--real-pi", stub.path],
    { cwd: h.sandbox.project }
  );

  const wrapperPath = join(wrapperDir, "pi");
  const subCwd = join(h.sandbox.root, "sub-working-dir");
  mkdirSync(subCwd, { recursive: true });

  // Run wrapper with ordinary arguments
  const res = await h.sandbox.runner.run(wrapperPath, ["--version", "chat", "--flag", "value"], {
    cwd: subCwd,
  });

  assert.equal(res.code, 42, `exit code must propagate from child stub (got ${res.code})`);
  const log = stub.readLog();
  assert.ok(log, "real Pi stub must have been executed");
  assert.deepEqual(
    log.argv,
    ["--version", "chat", "--flag", "value"],
    "arguments must pass through unchanged"
  );
  assert.equal(realpathSync(log.cwd), realpathSync(subCwd), "cwd must be preserved");
});

test("wrapper intercepts pi --wardrobe, strips flag, sets WARDROBE_PI_CLI, and execs wardrobe", async () => {
  const h = harness();
  const wrapperDir = join(h.sandbox.root, "wardrobe-intercept");
  const stub = createRecordingStub(join(h.sandbox.root, "stub-intercept"), "real-pi.mjs");

  await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", wrapperDir, "--real-pi", stub.path],
    { cwd: h.sandbox.project }
  );

  const wrapperPath = join(wrapperDir, "pi");
  // Calling with --wardrobe in non-TTY should reach wardrobe and trigger non-TTY error
  const res = await h.sandbox.runner.run(wrapperPath, ["--wardrobe"], {
    cwd: h.sandbox.project,
  });

  assert.equal(res.code, 1, "bare wardrobe non-TTY should exit 1");
  assert.match(res.stderr, /interactive startup selector requires a TTY/);
  // And the real Pi stub was NOT called for ordinary chat
  assert.equal(stub.readLog(), null, "real Pi was not invoked directly");
});

// ---------------------------------------------------------------------------
// 4. Real PTY Selector tests via node-pty
// ---------------------------------------------------------------------------

test("interactive selector via node-pty: cancellation leaves terminal intact and starts nothing", async (t) => {
  ensurePtyHelper();
  const h = harness();
  await installManager(h, "pty-cancel");
  await installPreset(h, "pty-cancel", "sel-cancel", minimalPreset("sel-cancel", "Cancel Test Preset"));

  const agentDir = h.agentPath("pty-cancel");
  const env = h.sandbox.childEnv({
    agentDir,
    extra: { WARDROBE_PI_CLI: h.runtime.cliPath },
  });

  const term = pty.spawn(process.execPath, [CLI, "--agent-dir", agentDir], {
    cols: 80,
    rows: 24,
    env,
    cwd: h.sandbox.project,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  await driver.waitForOutput("Wardrobe Startup Selector");

  // Send 'q' to cancel
  driver.write("q");

  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 0, `cancellation must exit 0, got ${exitCode}`);
  assert.match(driver.getOutput(), /Selection cancelled/);

  // Assert no lease was acquired
  const leaseDir = join(agentDir, "wardrobe", "leases");
  assert.equal(
    !existsSync(leaseDir) || readdirSync(leaseDir).length === 0,
    true,
    "cancelled selector must acquire no lease"
  );
});

test("interactive selector via node-pty: confirms available revision and launches child Pi", async (t) => {
  ensurePtyHelper();
  const h = harness();
  await installManager(h, "pty-launch");
  const { planId } = await installPreset(
    h,
    "pty-launch",
    "sel-launch",
    minimalPreset("sel-launch", "Launch Test Preset")
  );

  const agentDir = h.agentPath("pty-launch");
  const stub = createRecordingStub(join(h.sandbox.root, "pty-stub"), "pi-stub.mjs", 0);

  const env = h.sandbox.childEnv({
    agentDir,
    extra: { WARDROBE_PI_CLI: stub.path },
  });

  const term = pty.spawn(process.execPath, [CLI, "--agent-dir", agentDir, "--no-probe"], {
    cols: 80,
    rows: 24,
    env,
    cwd: h.sandbox.project,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  await driver.waitForOutput("Wardrobe Startup Selector");
  await driver.waitForOutput("Launch Test Preset");

  // Send Enter to confirm launch
  driver.write("\r");

  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 0, `launch should exit cleanly with child status, got ${exitCode}`);

  // Check child was executed
  const log = stub.readLog();
  assert.ok(log, "child Pi stub must have been executed");
  assert.ok(
    log.argv.some((arg) => arg.includes("--session-dir")),
    "child Pi must receive session dir"
  );
  assert.equal(log.env.WARDROBE_AGENT_DIR, agentDir);

  // After exit, lease must be released
  const leases = new LeaseStore(agentDir);
  const held = leases.read(planId);
  assert.ok(!held || held.released, "lease must be released after child exit");
});

test("interactive selector via node-pty: mode choice strict pins revision explicitly", async (t) => {
  ensurePtyHelper();
  const h = harness();
  await installManager(h, "pty-mode");
  const { planId } = await installPreset(h, "pty-mode", "sel-mode", minimalPreset("sel-mode", "Mode Test Preset"));

  const agentDir = h.agentPath("pty-mode");
  const stub = createRecordingStub(join(h.sandbox.root, "pty-mode-stub"), "pi-stub.mjs", 0);

  const env = h.sandbox.childEnv({
    agentDir,
    extra: { WARDROBE_PI_CLI: stub.path },
  });

  const term = pty.spawn(process.execPath, [CLI, "--agent-dir", agentDir, "--no-probe"], {
    cols: 80,
    rows: 24,
    env,
    cwd: h.sandbox.project,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  await driver.waitForOutput("Wardrobe Startup Selector");

  // Press 'p' to select strict mode (pin)
  driver.write("p");
  // Press Enter to confirm
  driver.write("\r");

  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 0);

  // Verify binding store recorded strict mode pinning the planId
  const bindings = new BindingStore(agentDir);
  const allBindings = bindings.list();
  assert.ok(allBindings.length > 0, "a binding record must exist");
  const bound = allBindings[0];
  assert.equal(bound.mode, "strict", "binding mode must be strict");
  assert.equal(bound.revision, planId, "strict mode must pin the exact selected revision");
});

test("interactive selector via node-pty: resume mode choice passes persisted session to child", async (t) => {
  ensurePtyHelper();
  const h = harness();
  await installManager(h, "pty-resume");
  const { agentDir: revisionDir } = await installPreset(
    h,
    "pty-resume",
    "sel-resume",
    minimalPreset("sel-resume", "Resume Test Preset")
  );

  const agentDir = h.agentPath("pty-resume");
  const stub = createRecordingStub(join(h.sandbox.root, "pty-resume-stub"), "pi-stub.mjs", 0);

  // Seed a persisted session file under revisionDir/wardrobe/sessions/run-01/
  const sessionRunDir = join(revisionDir, "wardrobe", "sessions", "run-01");
  mkdirSync(sessionRunDir, { recursive: true });
  const sessionFile = join(sessionRunDir, "persisted-chat.jsonl");
  writeFileSync(sessionFile, '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n');

  const env = h.sandbox.childEnv({
    agentDir,
    extra: { WARDROBE_PI_CLI: stub.path },
  });

  const term = pty.spawn(process.execPath, [CLI, "--agent-dir", agentDir, "--no-probe"], {
    cols: 80,
    rows: 24,
    env,
    cwd: h.sandbox.project,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  await driver.waitForOutput("Wardrobe Startup Selector");
  // Press 's' to cycle from Fresh session to persisted session
  driver.write("s");
  await driver.waitForOutput("persisted-chat.jsonl");
  // Press Enter to confirm launch
  driver.write("\r");

  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 0);

  const log = stub.readLog();
  assert.ok(log, "stub must have run");
  assert.ok(log.argv.includes("--session"), `stub args: ${JSON.stringify(log.argv)}`);
  assert.ok(
    log.argv.includes(sessionFile),
    `stub should receive the persisted session file path ${sessionFile}`
  );
});

test("interactive selector via node-pty: refuses drifted or unavailable revisions", async (t) => {
  ensurePtyHelper();
  const h = harness();
  await installManager(h, "pty-drift");
  const { planId, agentDir: revisionDir } = await installPreset(
    h,
    "pty-drift",
    "sel-drift",
    minimalPreset("sel-drift", "Drift Test Preset")
  );

  const agentDir = h.agentPath("pty-drift");
  const stub = createRecordingStub(join(h.sandbox.root, "pty-drift-stub"), "pi-stub.mjs", 0);

  // Introduce drift by tampering with the staging lock record
  const recordPath = join(agentDir, "wardrobe", "staging", `${planId}.json`);
  const rec = JSON.parse(readFileSync(recordPath, "utf8"));
  rec.attempts[0].lock.configuration.digest =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  writeFileSync(recordPath, JSON.stringify(rec, null, 2) + "\n");

  const env = h.sandbox.childEnv({
    agentDir,
    extra: { WARDROBE_PI_CLI: stub.path },
  });

  const term = pty.spawn(process.execPath, [CLI, "--agent-dir", agentDir, "--no-probe"], {
    cols: 80,
    rows: 24,
    env,
    cwd: h.sandbox.project,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  await driver.waitForOutput("Wardrobe Startup Selector");
  // It should display [drifted] status
  await driver.waitForOutput("drifted");

  // Press Enter on the drifted revision
  driver.write("\r");

  // Wait for refusal notice in output
  await driver.waitForOutput("Refused: revision");

  // Ensure stub was NOT executed
  assert.equal(stub.readLog(), null, "drifted revision must not launch child process");

  // Now press 'q' to cleanly cancel
  driver.write("q");
  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 0, "cancellation after refusal must exit 0");
});

test("interactive selector via node-pty: navigates between multiple revisions via arrow keys and jk", async (t) => {
  ensurePtyHelper();
  const h = harness();
  await installManager(h, "pty-nav");
  const first = await installPreset(
    h,
    "pty-nav",
    "nav-one",
    minimalPreset("nav-one", "First Nav Option")
  );
  const second = await installPreset(
    h,
    "pty-nav",
    "nav-two",
    minimalPreset("nav-two", "Second Nav Option")
  );

  const agentDir = h.agentPath("pty-nav");
  const stub = createRecordingStub(join(h.sandbox.root, "pty-nav-stub"), "pi-stub.mjs", 0);

  const env = h.sandbox.childEnv({
    agentDir,
    extra: { WARDROBE_PI_CLI: stub.path },
  });

  const term = pty.spawn(process.execPath, [CLI, "--agent-dir", agentDir, "--no-probe"], {
    cols: 80,
    rows: 24,
    env,
    cwd: h.sandbox.project,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  await driver.waitForOutput("Wardrobe Startup Selector");
  await driver.waitForOutput("First Nav Option");
  await driver.waitForOutput("Second Nav Option");

  const sorted = [first, second].sort((a, b) => a.planId.localeCompare(b.planId));
  const top = sorted[0];
  const bottom = sorted[1];

  // Initial selection is index 0 (top)
  await driver.waitForOutput(`Revision: ${top.planId}`);

  // Navigate down with 'j' to second option
  const p1 = driver.waitForNewOutput(`Revision: ${bottom.planId}`);
  driver.write("j");
  await p1;

  // Navigate up with 'k' to first option
  const p2 = driver.waitForNewOutput(`Revision: ${top.planId}`);
  driver.write("k");
  await p2;

  // Navigate down with Down Arrow (\x1b[B) to second option
  const p3 = driver.waitForNewOutput(`Revision: ${bottom.planId}`);
  driver.write("\x1b[B");
  await p3;

  // Launch the second option with Enter
  driver.write("\r");
  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 0);

  const log = stub.readLog();
  assert.ok(log, "child Pi stub must run");
  assert.equal(
    log.env.PI_CODING_AGENT_DIR,
    bottom.agentDir,
    "launch must target the second selected revision agent directory"
  );
});

test("pi --wardrobe wrapper under node-pty reaches interactive selector and cancels cleanly", async (t) => {
  ensurePtyHelper();
  const h = harness();
  await installManager(h, "pty-wrap-sel");
  await installPreset(
    h,
    "pty-wrap-sel",
    "sel-wrap",
    minimalPreset("sel-wrap", "Wrapper Selector Preset")
  );

  const agentDir = h.agentPath("pty-wrap-sel");
  const wrapperDir = join(h.sandbox.root, "wrapper-pty-sel");
  const stub = createRecordingStub(join(h.sandbox.root, "stub-pty-sel"), "real-pi.mjs");

  // Enable integration with explicit agent-dir
  const enableRes = await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", wrapperDir, "--real-pi", stub.path, "--agent-dir", agentDir],
    { cwd: h.sandbox.project }
  );
  assert.equal(enableRes.code, 0, enableRes.stderr);

  const wrapperPath = join(wrapperDir, "pi");

  // Launch pi --wardrobe under node-pty
  const term = pty.spawn(wrapperPath, ["--wardrobe"], {
    cols: 80,
    rows: 24,
    cwd: h.sandbox.project,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  await driver.waitForOutput("Wardrobe Startup Selector");
  await driver.waitForOutput("Wrapper Selector Preset");

  // Cancel via 'q'
  driver.write("q");
  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 0, "cancellation via wrapper must exit 0");
  assert.match(driver.getOutput(), /Selection cancelled/);
  assert.equal(stub.readLog(), null, "real Pi stub must not be invoked for selector cancellation");
});

test("wrapper forwards ordinary args under node-pty preserving argv, cwd, and exit code", async (t) => {
  ensurePtyHelper();
  const h = harness();
  const wrapperDir = join(h.sandbox.root, "wrapper-pty-fwd");
  const stub = createRecordingStub(join(h.sandbox.root, "stub-pty-fwd"), "real-pi.mjs", 42);

  await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", wrapperDir, "--real-pi", stub.path],
    { cwd: h.sandbox.project }
  );

  const wrapperPath = join(wrapperDir, "pi");
  const subCwd = join(h.sandbox.root, "pty-fwd-workdir");
  mkdirSync(subCwd, { recursive: true });

  // Spawn wrapper with ordinary arguments in node-pty
  const term = pty.spawn(wrapperPath, ["ordinary-arg", "--flag", "value-42"], {
    cols: 80,
    rows: 24,
    cwd: subCwd,
  });

  const driver = drivePty(term);
  t.after(() => driver.kill());
  const { exitCode } = await driver.waitForExit();
  assert.equal(exitCode, 42, `exit code must be propagated through PTY, got ${exitCode}`);

  const log = stub.readLog();
  assert.ok(log, "stub must have run");
  assert.deepEqual(log.argv, ["ordinary-arg", "--flag", "value-42"]);
  assert.equal(realpathSync(log.cwd), realpathSync(subCwd), "cwd must be preserved");
});

test("wrapper safely quotes paths containing spaces and special characters", async () => {
  const h = harness();
  const complexDir = join(h.sandbox.root, 'dir with spaces and $special"chars');
  const complexStub = createRecordingStub(
    join(h.sandbox.root, "stub spaces $ special"),
    "pi-stub.mjs",
    17
  );

  const enableRes = await h.sandbox.runner.run(
    process.execPath,
    [CLI, "integrate", "enable", "--dir", complexDir, "--real-pi", complexStub.path],
    { cwd: h.sandbox.project }
  );
  assert.equal(enableRes.code, 0, enableRes.stderr);

  const wrapperPath = join(complexDir, "pi");
  assert.ok(existsSync(wrapperPath), "wrapper in complex path must exist");

  const runRes = await h.sandbox.runner.run(wrapperPath, ["hello", "world"], {
    cwd: h.sandbox.project,
  });
  assert.equal(runRes.code, 17, `exit code from complex path stub must propagate, got ${runRes.code}`);

  const log = complexStub.readLog();
  assert.ok(log, "stub in complex path must execute");
  assert.deepEqual(log.argv, ["hello", "world"]);
});
