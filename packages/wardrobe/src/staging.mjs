// Owned staging for installed revisions.
//
// A revision is installed into its own agent directory under
// `<agentDir>/wardrobe/staging/`, never into the user's own agent directory and
// never over another revision. Every attempt gets a fresh directory, so a
// retry cannot inherit — or pretend to undo — the files a failed attempt left
// behind.
//
// A record is diagnostic state, not a promise: a failed attempt is retained as
// explicitly failed/unavailable rather than rolled back, because Pi's install
// runs package scripts and leaves whatever they left.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Files a fresh staging directory starts with. */
export function inactiveSettings(declarations) {
  return {
    // Nothing in a staged revision is active: every resource type of every
    // package is filtered out, so a staged revision can be inspected and a new
    // Pi process can start against it without loading a single resource.
    packages: declarations.map((declaration) => ({
      source: declaration.source,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    })),
  };
}

export class StagingStore {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "staging");
  }

  #recordPath(planId) {
    return join(this.root, `${planId}.json`);
  }

  /** The record for a revision, or null when nothing was installed for it. */
  read(planId) {
    const path = this.#recordPath(planId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }

  write(record) {
    mkdirSync(this.root, { recursive: true });
    const stamped = { ...record, updatedAt: new Date().toISOString() };
    writeFileSync(this.#recordPath(record.planId), `${JSON.stringify(stamped, null, 2)}\n`);
    return stamped;
  }

  /**
   * A fresh directory for one attempt.
   *
   * The attempt number is monotonic, so a retry lands beside the failed one
   * instead of on top of it.
   */
  attemptDir(planId, attempt) {
    return join(this.root, planId, `attempt-${attempt}`);
  }

  /** The attempt number a new install of this revision would use. */
  nextAttempt(record) {
    return (record?.attempts?.length ?? 0) + 1;
  }
}

/**
 * The installed inventory, which is not yet a launchable revision.
 *
 * Resources are filtered inactive; whether a process can actually start against
 * this revision is verified by the launch work, not claimed here.
 */
export function stagingViewOf(record, { selected = null, alreadyAvailable = false } = {}) {
  const latest = selected ?? record.attempts.at(-1) ?? null;
  return {
    revision: record.planId,
    state: record.state,
    digest: record.digest,
    agentDir: latest?.agentDir ?? null,
    attempt: latest?.attempt ?? null,
    alreadyAvailable: alreadyAvailable === true,
    previousAttemptsRetained: record.previousAttemptsRetained,
    installed: latest?.installed ?? [],
    resourcesActive: latest?.resources?.active ?? 0,
    residual: latest?.residual ?? [],
    rolledBack: latest?.rolledBack ?? false,
    // Explicit, because the difference matters to everything that follows.
    verifiedLaunchable: false,
  };
}

/**
 * What an attempt left behind.
 *
 * Reported, never removed: an install may have run package scripts, so this
 * lists what exists rather than claiming the directory is clean.
 */
export function residualOf(attemptDir, limit = 200) {
  if (!existsSync(attemptDir)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= limit) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(attemptDir, path).split(sep).join("/"));
    }
  };
  walk(attemptDir);
  return files.sort().slice(0, limit);
}
