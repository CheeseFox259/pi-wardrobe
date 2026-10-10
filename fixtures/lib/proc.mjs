// Child-process helper that keeps track of every process it starts so the
// harness can guarantee no fixture-owned process survives cleanup.
import { spawn } from "node:child_process";

export class ProcessRunner {
  #children = new Set();
  #timeoutMs;

  constructor({ timeoutMs = 120_000 } = {}) {
    this.#timeoutMs = timeoutMs;
  }

  get liveChildren() {
    return this.#children.size;
  }

  /**
   * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>}
   */
  run(bin, args, { cwd, env, timeoutMs = this.#timeoutMs, onSpawn } = {}) {
    return new Promise((done, fail) => {
      const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      this.#children.add(child);
      onSpawn?.(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        this.#children.delete(child);
        fail(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.#children.delete(child);
        done({ code, signal, stdout, stderr, timedOut });
      });
    });
  }

  /** Fork a long-lived child (RPC sessions) and hand it to the caller. */
  fork(bin, args, { cwd, env } = {}) {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#children.add(child);
    const forget = () => this.#children.delete(child);
    child.on("close", forget);
    return child;
  }

  release(child) {
    this.#children.delete(child);
  }

  killAll() {
    for (const child of [...this.#children]) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; nothing left to reclaim.
      }
    }
    this.#children.clear();
  }
}
