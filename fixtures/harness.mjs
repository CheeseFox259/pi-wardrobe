// Controlled native-fixture harness for Pi Wardrobe implementation tickets.
//
// One call builds every controlled input a later ticket needs to exercise real
// Pi installation, staging and launch behaviour locally: a Bare Git source with
// two immutable commits served over loopback HTTP, a loopback npm registry with
// self-authored tarballs, and a set of isolated agent directories.
//
// Guarantees:
//   - nothing is published, pushed or installed into the caller's environment
//   - every write stays inside one temporary root that is removed on dispose
//   - child processes receive a credential-free environment allowlist
//   - cleanup runs on success, on failure, and from an exit safety net
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EVIDENCE_DIR, EvidenceRecorder } from "./lib/evidence.mjs";
import { buildGitRepo } from "./lib/git-repo.mjs";
import { GitSourceFixture } from "./lib/git-source.mjs";
import { LoopbackServer } from "./lib/http.mjs";
import { NpmRegistryFixture } from "./lib/npm-registry.mjs";
import { PiRunner } from "./lib/pi-runner.mjs";
import { resolvePiRuntime, runtimeSummary } from "./lib/runtime.mjs";
import { readJson, readJsonl, readText } from "./lib/fsx.mjs";
import { Sandbox } from "./lib/sandbox.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Agents seeded for every harness: one control, one working, one isolated. */
const DEFAULT_AGENTS = ["baseline", "primary", "second"];

export async function createFixtureHarness({
  label = "native-fixture",
  evidenceDir = DEFAULT_EVIDENCE_DIR,
  agents = DEFAULT_AGENTS,
} = {}) {
  const sandbox = await Sandbox.create();
  const runtime = resolvePiRuntime();
  const server = new LoopbackServer();
  await server.start();

  let released = false;
  const safetyNet = () => {
    if (released) return;
    try {
      recorder.write();
    } catch {
      // The exit path cannot report; the test output already carries failures.
    }
    sandbox.runner.killAll();
    try {
      rmSync(sandbox.root, { recursive: true, force: true });
    } catch {
      // Nothing further can be done while the process is exiting.
    }
  };
  process.once("exit", safetyNet);

  let recorder;
  try {
    const git = await GitSourceFixture.create({ sandbox, server });
    const npm = await NpmRegistryFixture.create({ sandbox, server });
    npm.configureNpm();
    for (const name of agents) sandbox.seedAgent(name);

    const pi = new PiRunner({ sandbox, runtime });
    recorder = new EvidenceRecorder({
      label,
      runtime: runtimeSummary(runtime, await pi.npmVersion()),
      outDir: resolve(REPO_ROOT, evidenceDir),
      root: sandbox.root,
    });
    recorder.record("fixtures-ready", {
      origin: server.origin,
      gitCommits: git.commits,
      npmVersions: npm.versions.map((entry) => entry.version),
      agents,
      runtime: recorder.runtime,
    });

    const harness = {
      sandbox,
      runtime,
      server,
      git,
      npm,
      pi,
      evidence: recorder,

      record: (name, details) => recorder.record(name, details),

      /**
       * Build and serve an additional controlled repository. Used by checks that
       * need repositories the shipped fixture does not provide, such as
       * multi-preset repositories or ones whose resources must be refused.
       */
      gitRepo: (name, commits) => buildGitRepo({ sandbox, server, name, commits }),

      /**
       * Build and serve an additional controlled npm package on the same
       * loopback registry. Composition checks need two distinct canonical
       * packages, and two versions of one, to tell the rules apart.
       */
      npmPackage: (name, versions) =>
        NpmRegistryFixture.create({ sandbox, server, name, versions }),

      agentPath: (name) => sandbox.agentPath(name),
      settings: (name) => readJson(`${sandbox.agentPath(name)}/settings.json`),
      settingsBytes: (name) => readText(`${sandbox.agentPath(name)}/settings.json`),
      snapshotAgent: (name) => sandbox.snapshotAgent(name),
      gitCheckout: (name) => git.checkoutIn(sandbox.agentPath(name)),
      installedNpmPackage: (name) => npm.installedPath(sandbox.agentPath(name)),
      installedNpmVersion: (name) => npm.installedVersion(sandbox.agentPath(name)),

      /** Every dependency install script that reported in, in order. */
      markerEvents: () => readJsonl(sandbox.markerLog),
      /** Every fixture-extension lifecycle event that reported in, in order. */
      extensionEvents: () => readJsonl(sandbox.extensionLog),

      async dispose() {
        if (released) return;
        released = true;
        process.off("exit", safetyNet);
        await server.close();
        await sandbox.dispose();
        recorder.write();
      },
    };
    return harness;
  } catch (error) {
    safetyNet();
    throw error;
  }
}
