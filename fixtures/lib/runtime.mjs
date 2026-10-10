// Resolve the Pi runtime under test without depending on the caller's shell PATH.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const RUNTIME_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Managed install roots, most explicit first. `WARDROBE_FIXTURE_PI_ROOT` lets a
 * caller point the fixtures at an uninstalled checkout; the managed release root
 * is the supported default.
 */
function candidateInstallRoots(env) {
  return [
    env.WARDROBE_FIXTURE_PI_ROOT ? resolve(env.WARDROBE_FIXTURE_PI_ROOT) : null,
    env.PI_MANAGED_INSTALL_ROOT ? resolve(env.PI_MANAGED_INSTALL_ROOT) : null,
    env.PI_CODING_AGENT_DIR
      ? join(resolve(env.PI_CODING_AGENT_DIR), "install")
      : null,
    join(homedir(), ".pi", "agent", "install"),
  ].filter(Boolean);
}

function readVersion(installRoot) {
  const marker = join(installRoot, "current-version");
  if (!existsSync(marker)) return null;
  const version = readFileSync(marker, "utf8").trim();
  return version || null;
}

/**
 * @returns {{installRoot: string, runtimeRoot: string, cliPath: string, version: string}}
 */
export function resolvePiRuntime(env = process.env) {
  const attempts = [];
  for (const installRoot of candidateInstallRoots(env)) {
    const version = readVersion(installRoot);
    if (!version) {
      attempts.push(`${installRoot}: no current-version marker`);
      continue;
    }
    const runtimeRoot = join(
      installRoot,
      "releases",
      version,
      "node_modules",
      RUNTIME_PACKAGE
    );
    const cliPath = join(runtimeRoot, "dist", "cli.js");
    if (!existsSync(cliPath)) {
      attempts.push(`${runtimeRoot}: no dist/cli.js`);
      continue;
    }
    return { installRoot, runtimeRoot, cliPath, version };
  }
  throw new Error(
    `Unable to locate a Pi runtime to exercise. Tried:\n  ${attempts.join("\n  ")}`
  );
}

/** Recorded verbatim in the evidence report so readers know what was exercised. */
export function runtimeSummary(runtime, npmVersion) {
  return {
    pi: runtime.version,
    node: process.version,
    npm: npmVersion,
    platform: process.platform,
    arch: process.arch,
    piRuntimeRoot: runtime.runtimeRoot,
  };
}
