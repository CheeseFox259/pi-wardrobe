// Ownership of an installed revision.
//
// Two Pi processes with write access to the same revision directory can
// corrupt it in ways neither can see, so ownership is explicit and held for the
// lifetime of a process. A lease is a small owned record; it is taken before
// anything is written and released when the process ends.
//
// A lease whose process is gone is stale: it is diagnosed and replaced, because
// leaving it would block the revision forever. A lease whose process is alive is
// never taken, whatever its age — stale ownership is diagnosed, and live work
// is never stolen.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { assertSafeId } from "./staging.mjs";

/** What a lease authorises. Both write to the revision directory. */
const LEASE_KINDS = ["run", "write"];

export class LeaseStore {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "leases");
  }

  #pathFor(revision) {
    assertSafeId(revision);
    return join(this.root, `${revision}.json`);
  }

  read(revision) {
    const path = this.#pathFor(revision);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      // An unreadable lease is treated as held, not as absent: an unreadable
      // record must not become a way around ownership.
      return { revision, kind: "unknown", pid: null, unreadable: error.message };
    }
  }

  write(lease) {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.#pathFor(lease.revision), `${JSON.stringify(lease, null, 2)}\n`);
    return lease;
  }

  /**
   * Release a lease this run took.
   *
   * The run id is checked so a slow exit cannot release a lease that a later
   * process has since taken.
   */
  release(revision, runId) {
    const held = this.read(revision);
    if (!held) return false;
    if (held.runId !== runId) return false;
    rmSync(this.#pathFor(revision), { force: true });
    return true;
  }

  /** Delete any lease record for this revision unconditionally. */
  delete(revision) {
    assertSafeId(revision);
    rmSync(this.#pathFor(revision), { force: true });
  }

  /**
   * Take the revision, or explain why it cannot be taken.
   *
   * @returns {{granted: true, lease: object, replacedStale: object|null}
   *   | {granted: false, held: object, reason: string}}
   */
  acquire({ revision, kind, runId, pid, agentDir, command }) {
    if (!LEASE_KINDS.includes(kind)) {
      return { granted: false, held: null, reason: `unknown lease kind ${JSON.stringify(kind)}` };
    }
    const held = this.read(revision);
    if (held && !isStale(held)) {
      return { granted: false, held, reason: leaseReason(held) };
    }
    const lease = {
      revision,
      kind,
      runId,
      pid: pid ?? process.pid,
      host: hostname(),
      agentDir: agentDir ?? null,
      command: command ?? null,
      startedAt: new Date().toISOString(),
    };
    this.write(lease);
    return { granted: true, lease, replacedStale: held ?? null };
  }
}

/**
 * Whether a lease's owner is still there.
 *
 * A lease without a readable pid cannot be proven dead, so it counts as held.
 * Guessing wrong in that direction blocks a revision; guessing wrong in the
 * other direction hands two writers the same directory. Every caller that
 * refuses because of a lease asks this question, so there is one answer.
 */
export function isStale(lease) {
  if (!lease) return true;
  if (lease.unreadable) return false;
  if (!Number.isInteger(lease.pid) || lease.pid <= 0) return false;
  return !isProcessAlive(lease.pid);
}

/** True when a process with this pid exists on this host. */
function isProcessAlive(pid) {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. EPERM means it exists and belongs to someone else.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Why a lease is being respected.
 *
 * One description for every caller that refuses: a refusal that said "unknown
 * pid null" when the real problem was an unreadable record would send the reader
 * looking in the wrong place.
 */
export function leaseReason(lease) {
  if (!lease) return null;
  if (lease.unreadable) {
    return `its lease record is unreadable (${lease.unreadable}); it is treated as held rather than absent`;
  }
  if (lease.kind === "unknown") {
    return "its lease record names no holder; it is treated as held rather than absent";
  }
  return `${lease.kind} pid ${lease.pid} on ${lease.host} since ${lease.startedAt} is still there`;
}

/**
 * The report form: what is held, and whether it looks alive.
 *
 * `alive` and `stale` are one decision, not two: a lease that cannot be proven
 * dead is alive here, which is the same rule `acquire` follows when it refuses.
 * A record that read as "not alive" while `acquire` treated it as held would
 * let `use` plan a launch that `run` then refuses.
 */
export function leaseViewOf(lease) {
  if (!lease) return null;
  return {
    revision: lease.revision ?? null,
    kind: lease.kind ?? null,
    runId: lease.runId ?? null,
    pid: lease.pid ?? null,
    host: lease.host ?? null,
    startedAt: lease.startedAt ?? null,
    command: lease.command ?? null,
    unreadable: lease.unreadable ?? null,
    alive: !isStale(lease),
    stale: isStale(lease),
  };
}
