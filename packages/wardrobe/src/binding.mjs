// Bindings: which revision a preset is meant to run, and how.
//
// A binding is a durable statement of intent — follow by default, strict when a
// user pins one — kept beside the revisions it names. It is not a lease, not a
// lock and not a session: it says what should be true when a session starts,
// and it is what a later resume checks the world against.
//
// Two different things are recorded, and keeping them apart is the point:
//
//   binding.json    what the user asked for: mode, target revision, and the
//                   soft overrides that go with it
//   migrations      what actually happened between one launch and the next,
//                   append-only, with both revisions named
//
// A binding is a file, so it outlives the session that made it. What is
// transient is a *session preference* — the soft overrides a session adopts in
// place — because a custom entry alone does not flush a conversation. That is
// why this store says what should be true at the next launch and never claims
// a conversation is bound to a revision.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryKeyOf } from "./identity.mjs";

/** The two ways a preset can be bound. */
export const MODES = ["follow", "strict"];

/** What a binding is allowed to say about itself. */
export const BINDING_SCHEMA = 1;

/**
 * Bindings on disk, one file per preset.
 *
 * A binding is a file rather than a session entry so that it outlives the
 * session that made it, and so a resume can be checked against something
 * durable rather than against what a process happened to hold.
 */
export class BindingStore {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "bindings");
  }

  #pathFor(presetKey) {
    return join(this.root, `${slugOf(presetKey)}.json`);
  }

  /** The binding for a preset, or null when there is none. */
  read(presetKey) {
    const path = this.#pathFor(presetKey);
    if (!existsSync(path)) return null;
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record.schemaVersion !== BINDING_SCHEMA) {
        return { ...record, unreadable: `unsupported binding schema ${record.schemaVersion}` };
      }
      return record;
    } catch (error) {
      // An unreadable binding is not an absent one: a binding that cannot be
      // read cannot be honoured, and silently treating it as absent would run
      // something the user pinned against.
      return {
        schemaVersion: BINDING_SCHEMA,
        preset: presetKey,
        mode: null,
        revision: null,
        unreadable: error.message,
        migrations: [],
      };
    }
  }

  /** Every binding recorded, in a stable order. */
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => this.read(entry.replace(/\.json$/, "")))
      .filter(Boolean);
  }

  /** Replace a binding. A mode or target that is not mentioned is forgotten. */
  write(record) {
    mkdirSync(this.root, { recursive: true });
    const stamped = { ...record, updatedAt: new Date().toISOString() };
    writeFileSync(this.#pathFor(record.preset), `${JSON.stringify(stamped, null, 2)}\n`);
    return stamped;
  }
}

/**
 * Record what a user asked for.
 *
 * Changing mode or target is a deliberate act: a binding is replaced, not
 * merged, so a previous target cannot linger in a field the new one does not
 * mention.
 */
export function bindRequest({
  preset,
  mode,
  revision = null,
  soft = null,
  restrictions = [],
  configurationDigest = null,
  previous = null,
  sessionId = null,
}) {
  if (!MODES.includes(mode)) return { ok: false, reason: `unknown mode ${JSON.stringify(mode)}` };
  if (mode === "strict" && !revision) {
    return {
      ok: false,
      reason: "strict mode pins an exact revision; name one",
    };
  }
  const now = new Date().toISOString();
  return {
    ok: true,
    record: {
      schemaVersion: BINDING_SCHEMA,
      preset,
      mode,
      // Follow does not pin, but it may still name a revision the user had in
      // mind; what it actually runs is decided at each launch.
      revision: revision ?? null,
      // What the revision was expected to configure, so a later resume can say
      // whether it is still the same configuration and not merely the same
      // directory.
      configurationDigest: configurationDigest ?? previous?.configurationDigest ?? null,
      soft,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      // Where the request came from, kept so a later report can say whether a
      // user typed it or a session did. The binding itself is a file, so it
      // outlives the session that made it.
      boundFromSession: sessionId,
      durable: true,
      migrations: previous?.migrations ?? [],
      lastLaunched: previous?.lastLaunched ?? null,
      // Restrictions a user placed on this preset. A follow that cannot honour
      // one refuses rather than quietly running without it.
      restrictions: restrictions.length > 0 ? restrictions : (previous?.restrictions ?? []),
    },
  };
}

/**
 * What a launch should actually run.
 *
 * Follow takes the newest approved, available revision of the same
 * source-qualified preset, ordered by when it was approved — not by a version
 * label, and not by whatever is newest on a network. Strict takes the pinned
 * revision or refuses; it never substitutes.
 *
 * @returns {{ok: boolean, mode: string, revision: object|null, reason: string|null,
 *   migration: object|null, restrictions: string[]}}
 */
export function resolveBinding({ binding, reports, plans }) {
  const restrictions = binding?.restrictions ?? [];
  if (!binding) {
    return { ok: false, mode: null, revision: null, reason: "no binding is recorded", restrictions, migration: null };
  }
  if (binding.unreadable) {
    return {
      ok: false,
      mode: null,
      revision: null,
      reason: `the binding cannot be read (${binding.unreadable})`,
      restrictions,
      migration: null,
    };
  }
  const available = reports.filter((report) => report.state === "available");
  const same = available.filter((report) => repositoryKeyOf(report.preset) === binding.preset);

  if (binding.mode === "strict") {
    const pinned = reports.find((report) => report.revision === binding.revision);
    if (!pinned) {
      return {
        ok: false,
        mode: "strict",
        revision: null,
        reason: `the pinned revision ${binding.revision} is not installed`,
        restrictions,
        migration: null,
      };
    }
    if (pinned.state !== "available") {
      return {
        ok: false,
        mode: "strict",
        revision: pinned,
        // A strict mismatch is a refusal with options, never a substitution.
        reason: `the pinned revision ${binding.revision} is ${pinned.state}`,
        restrictions,
        migration: null,
      };
    }
    // Strict records its first launch too: a move from nothing is a move.
    return {
      ok: true,
      mode: "strict",
      revision: pinned,
      reason: null,
      restrictions,
      migration: migrationFrom({ binding, chosen: pinned }),
    };
  }

  if (same.length === 0) {
    return {
      ok: false,
      mode: "follow",
      revision: null,
      reason: `no approved available revision of ${binding.preset}`,
      restrictions,
      migration: null,
    };
  }
  // Approval order, not a version label: a preset may publish 2.0.0 after
  // 1.1.0 was approved, and the newest approved revision is the one that was
  // reviewed last, not the one with the highest number.
  const newest = [...same].sort((a, b) => approvedAtOf(a, plans).localeCompare(approvedAtOf(b, plans)));
  const chosen = newest.at(-1);

  // An explicit restriction is a decision, not a preference. Running without it
  // would be running something other than what was asked for, so the resolution
  // refuses and says which restriction is in the way.
  const unmet = unmetRequirementsOf(chosen, plans);
  if (unmet.length > 0) {
    return {
      ok: false,
      mode: "follow",
      revision: null,
      reason: `the newest approved revision cannot meet a requirement: ${unmet.join("; ")}`,
      restrictions: [...restrictions, ...unmet],
      migration: null,
    };
  }
  if (restrictions.length > 0) {
    return {
      ok: false,
      mode: "follow",
      revision: null,
      reason: `this preset is restricted and the resolution does not say how it is satisfied: ${restrictions.join("; ")}`,
      restrictions,
      migration: null,
    };
  }
  return {
    ok: true,
    mode: "follow",
    revision: chosen,
    reason: null,
    restrictions,
    migration: migrationFrom({ binding, chosen }),
  };
}

/** Requirements the chosen revision declares that cannot be met. */
export function unmetRequirementsOf(report, plans) {
  const plan = plans?.get(report?.revision);
  return (plan?.runtime?.tools?.unmet ?? []).map(
    (entry) => `tool ${entry.tool}: ${entry.reason}`
  );
}

/**
 * What a launch moved between, if anything.
 *
 * Recorded so a resume is traceable after the fact: which revision the session
 * last ran, which it runs now, and whether anything about the configuration
 * changed. Old messages are not rewritten and no old revision is deleted.
 */
export function migrationFrom({ binding, chosen }) {
  const from = binding.lastLaunched ?? null;
  if (from === chosen.revision) return null;
  return {
    at: new Date().toISOString(),
    from,
    to: chosen.revision,
    mode: binding.mode,
    reason:
      from === null
        ? "first launch for this binding"
        : "follow selected the newest approved available revision",
  };
}

/** Append a migration to a binding without rewriting its earlier ones. */
export function recordMigration(binding, migration) {
  if (!migration) return binding;
  return { ...binding, lastLaunched: migration.to, migrations: [...(binding.migrations ?? []), migration] };
}

/** When a revision's plan was approved, which is the order follow follows. */
export function approvedAtOf(report, plans) {
  if (!report) return "";
  return plans?.get(report.revision)?.approved?.at ?? report.recordedAt ?? "";
}

/** A filename-safe form of a preset key. */
function slugOf(presetKey) {
  return String(presetKey).replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * What a session should be told about its binding, when it is told at all.
 *
 * A launch coordination record is not a durable binding: it exists for the
 * lifetime of one process, and it is what a later resume reads to know what the
 * session believed. It is kept out of the binding so that a session which never
 * persisted a conversation leaves no trace that outlives it.
 */
/**
 * What each launch believed it was running.
 *
 * Deliberately separate from bindings, and deliberately not durable state about
 * a conversation: this is coordination for one process, and it is what a later
 * resume reads to know what a session was doing.
 */
export class LaunchRecords {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "launches");
  }

  /** Replace a binding. A mode or target that is not mentioned is forgotten. */
  /** Record one launch, named for the run it belongs to. */
  write(record) {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  /** The newest launch record, whatever revision it named. */
  latest() {
    if (!existsSync(this.root)) return null;
    const files = readdirSync(this.root).filter((entry) => entry.endsWith(".json"));
    if (files.length === 0) return null;
    const records = files
      .map((entry) => JSON.parse(readFileSync(join(this.root, entry), "utf8")))
      .sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
    return records.at(-1) ?? null;
  }
}
