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

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { lockDigestOf } from "./lock.mjs";

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

export function assertSafeId(id) {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..") ||
    id.includes("\0")
  ) {
    throw new Error(`invalid identifier ${JSON.stringify(id)}: path traversal is not permitted`);
  }
}

/**
 * Verify that a revision's root directory and every attempt directory stay
 * strictly confined within the owned staging root.
 *
 * @throws {Error} if escaping symlinks, missing paths, or outside paths are detected
 */
export function verifyPlanConfinement({ stagingRoot, planId, attemptDirs = [] }) {
  assertSafeId(planId);
  if (!existsSync(stagingRoot)) {
    throw new Error(`staging root ${stagingRoot} does not exist`);
  }
  const realStagingRoot = realpathSync(stagingRoot);
  const planRoot = join(stagingRoot, planId);
  if (!existsSync(planRoot)) {
    throw new Error(`revision directory ${planRoot} does not exist on disk`);
  }
  const realPlanRoot = realpathSync(planRoot);
  if (!realPlanRoot.startsWith(realStagingRoot + sep) || realPlanRoot === realStagingRoot) {
    throw new Error(
      `revision root ${planRoot} (resolving to ${realPlanRoot}) escapes staging root ${realStagingRoot}`
    );
  }
  for (const attemptDir of attemptDirs) {
    if (!attemptDir || !existsSync(attemptDir)) {
      throw new Error(`attempt directory ${attemptDir ?? "(none)"} does not exist on disk`);
    }
    const realAttemptDir = realpathSync(attemptDir);
    if (!realAttemptDir.startsWith(realPlanRoot + sep) || realAttemptDir === realPlanRoot) {
      throw new Error(
        `attempt directory ${attemptDir} (resolving to ${realAttemptDir}) escapes revision root ${realPlanRoot}`
      );
    }
  }
  for (const entry of readdirSync(planRoot)) {
    const entryPath = join(planRoot, entry);
    const realEntryPath = realpathSync(entryPath);
    if (!realEntryPath.startsWith(realPlanRoot + sep) || realEntryPath === realPlanRoot) {
      throw new Error(
        `revision entry ${entryPath} (resolving to ${realEntryPath}) escapes revision root ${realPlanRoot}`
      );
    }
  }
  return { planRoot, realPlanRoot, realStagingRoot };
}

export class StagingStore {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "staging");
  }

  #recordPath(planId) {
    assertSafeId(planId);
    return join(this.root, `${planId}.json`);
  }

  /** The record for a revision, or null when nothing was installed for it. */
  read(planId) {
    const path = this.#recordPath(planId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }

  /**
   * Every record this store holds, in revision order.
   *
   * A record that cannot be read is named rather than skipped: a store whose
   * contents cannot all be listed cannot be reported as the full picture.
   */
  list() {
    if (!existsSync(this.root)) return { records: [], unreadable: [] };
    const records = [];
    const unreadable = [];
    for (const entry of readdirSync(this.root).sort()) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.root, entry);
      try {
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (record?.planId === basename(entry, ".json")) records.push(record);
        else unreadable.push({ file: entry, reason: "the record does not name its own revision" });
      } catch (error) {
        unreadable.push({ file: entry, reason: `unreadable record: ${error.message}` });
      }
    }
    return { records, unreadable };
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

  /**
   * Delete an installed revision: remove its record and its attempt directories.
   *
   * Verifies realpath confinement within staging before any deletion occurs,
   * ensuring metadata is never destroyed if confinement fails.
   */
  delete(planId) {
    assertSafeId(planId);
    const planRoot = join(this.root, planId);
    if (existsSync(planRoot)) {
      verifyPlanConfinement({ stagingRoot: this.root, planId });
    }
    const record = this.#recordPath(planId);
    if (existsSync(record)) {
      rmSync(record, { force: true });
    }
    if (existsSync(planRoot)) {
      rmSync(planRoot, { recursive: true, force: true });
    }
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
    // Set when the previous attempt was replaced rather than reused, and why.
    superseded: record.superseded ?? null,
    installed: latest?.installed ?? [],
    // The lock is what makes this revision checkable later; the inventory
    // above is not, on its own, evidence that anything is intact.
    lock: latest?.lock ?? null,
    lockDigest: latest?.lock ? lockDigestOf(latest.lock) : null,
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
