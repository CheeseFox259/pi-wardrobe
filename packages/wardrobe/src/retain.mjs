// Explicit user retention of installed revisions.
//
// WHY:
// A user may want to keep specific revisions installed for reference, testing,
// or regression inspection without pinning their session in strict mode.
// An explicit retain reference is durable state stored beside bindings and leases,
// ensuring garbage collection and deletion commands do not remove the revision
// until deliberately released.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeId } from "./staging.mjs";

export const RETAIN_SCHEMA = 1;

export class RetainStore {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "retains");
  }

  #pathFor(revision) {
    assertSafeId(revision);
    return join(this.root, `${revision}.json`);
  }

  read(revision) {
    const path = this.#pathFor(revision);
    if (!existsSync(path)) return null;
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record.schemaVersion !== RETAIN_SCHEMA) {
        return { ...record, unreadable: `unsupported retain schema ${record.schemaVersion}` };
      }
      return record;
    } catch (error) {
      return {
        schemaVersion: RETAIN_SCHEMA,
        revision,
        preset: null,
        unreadable: error.message,
      };
    }
  }

  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => this.read(entry.replace(/\.json$/, "")))
      .filter(Boolean);
  }

  write(record) {
    mkdirSync(this.root, { recursive: true });
    const now = new Date().toISOString();
    const stamped = {
      schemaVersion: RETAIN_SCHEMA,
      ...record,
      retainedAt: record.retainedAt ?? now,
      updatedAt: now,
    };
    writeFileSync(this.#pathFor(record.revision), `${JSON.stringify(stamped, null, 2)}\n`);
    return stamped;
  }

  delete(revision) {
    assertSafeId(revision);
    const path = this.#pathFor(revision);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }
}

/**
 * Read and summarize all explicit retain references.
 */
export function listRetains(agentDir) {
  const retains = new RetainStore(agentDir).list();
  return {
    mode: "read",
    retains,
    state: retains.length === 0 ? "none-retained" : "retained",
    installed: false,
    active: false,
  };
}
