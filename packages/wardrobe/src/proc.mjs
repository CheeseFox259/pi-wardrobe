// Minimal child-process helper for the `git` calls the manager makes.
//
// Kept deliberately small: the manager shells out to Git and reads the result.
// It never executes package or Extension code.

import { spawn } from "node:child_process";

export function run(bin, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function git(args, options) {
  const result = await run("git", args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Dispatch command and arguments for a Pi executable.
 *
 * If the CLI is a Node script (.js, .mjs), runs via process.execPath with the
 * script path as the first argument; otherwise executes the binary/wrapper directly.
 *
 * @param {string} cli
 * @param {string[]} args
 * @returns {[file: string, args: string[]]}
 */
export function dispatchPiCommand(cli, args = []) {
  const isScript = cli.endsWith(".js") || cli.endsWith(".mjs");
  return isScript ? [process.execPath, [cli, ...args]] : [cli, [...args]];
}
