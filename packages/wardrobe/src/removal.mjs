// Removal and release of installed revisions.
//
// WHY:
// Deleting an installed revision must be safe, bounded, and deliberate.
// Active revisions (live leases, running sessions), strict bindings, and
// explicit retention references block deletion.
// Any safety hazard (missing path, stale lease, escaping symlinks, ambiguous
// ownership) must be diagnosed and refused rather than used to delete arbitrary
// directories.
// Removal operates strictly within the manager's owned staging directory and
// never touches the user's personal environment or unrelated revisions.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { isStale, leaseReason, LeaseStore } from "./lease.mjs";
import { BindingStore } from "./binding.mjs";
import { RetainStore } from "./retain.mjs";
import { assertSafeId, StagingStore, verifyPlanConfinement } from "./staging.mjs";
import { PlanStore } from "./approval.mjs";
import { repositoryKeyOf } from "./identity.mjs";
import { runningRevisionOf } from "./session.mjs";
import { diagnoseAll, resolvePresetKey, selectRevision } from "./revisions.mjs";

/**
 * Find all session transcript files inside a revision root.
 */
export function findSessionTranscripts(planRoot) {
  if (!existsSync(planRoot)) return [];
  const transcripts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        transcripts.push(fullPath);
      }
    }
  };
  for (const entry of readdirSync(planRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sessionsDir = join(planRoot, entry.name, "wardrobe", "sessions");
      if (existsSync(sessionsDir)) {
        walk(sessionsDir);
      }
    }
  }
  return transcripts.sort();
}

/**
 * Shared target resolution for remove, release, and retain commands.
 *
 * Resolves the preset against installed reports, ensures unambiguous naming,
 * resolves an optional revision selector (by id, source-qualified identity,
 * or preset name via selectRevision), and validates that the revision belongs
 * to the resolved preset.
 */
export async function resolveTarget({
  agentDir,
  presetSelector,
  revisionSelector = null,
  env = process.env,
  commandName = "remove",
}) {
  if (!presetSelector) {
    throw WardrobeError.from(
      `/wardrobe ${commandName} needs a preset`,
      [],
      `usage: /wardrobe ${commandName} <preset>${commandName === "release" || commandName === "retain" ? " --revision <revision>" : " [--revision <revision>]"}`
    );
  }

  if (revisionSelector === true || (revisionSelector !== null && typeof revisionSelector !== "string")) {
    throw WardrobeError.from(
      `--revision flag needs a revision argument`,
      [],
      `usage: /wardrobe ${commandName} <preset> --revision <revision>`
    );
  }

  const { reports, unreadable, plans } = await diagnoseAll(agentDir, { env });
  const canonical = resolvePresetKey(presetSelector, reports);
  if (!canonical.ok) {
    throw WardrobeError.from(
      `the preset to ${commandName} is not named unambiguously`,
      [
        new WardrobeDiagnostic({ path: `/${commandName}/preset`, reason: canonical.reason }),
        ...(canonical.candidates ?? []).map(
          (entry) => new WardrobeDiagnostic({ path: `/${commandName}/preset`, reason: `candidate: ${entry}` })
        ),
      ],
      "see /wardrobe list for known presets"
    );
  }

  const presetReports = reports.filter((r) => repositoryKeyOf(r.preset) === canonical.presetKey);

  let target = null;
  if (revisionSelector) {
    target = selectRevision(reports, revisionSelector, { unreadable });
    const targetPreset = repositoryKeyOf(target.preset);
    if (targetPreset !== canonical.presetKey) {
      throw WardrobeError.from(
        `revision ${target.revision} belongs to ${targetPreset}, not ${canonical.presetKey}`,
        [
          new WardrobeDiagnostic({
            path: `/${commandName}/${target.revision}/ownership`,
            reason: `preset mismatch: belongs to ${targetPreset}`,
          }),
        ],
        "refusing operation due to ambiguous ownership"
      );
    }
  }

  return {
    canonical,
    target,
    reports,
    unreadable,
    plans,
    presetReports,
  };
}

/**
 * Evaluate whether an installed revision can be safely deleted.
 *
 * Distinguishes:
 * - "refused": a safety or integrity hazard was diagnosed (missing path, escaping symlink,
 *              stale lease, ambiguous ownership).
 * - "blocked": the revision is intact and owned, but is actively referenced (active lease,
 *              running session, strict binding, explicit retain).
 * - "removable": the revision is safe, unreferenced, and can be removed.
 */
export function evaluateRevision({ agentDir, report, session = null, expectedPresetKey = null }) {
  const revision = report.revision;
  assertSafeId(revision);

  const stagingStore = new StagingStore(agentDir);
  const leaseStore = new LeaseStore(agentDir);
  const bindingStore = new BindingStore(agentDir);
  const retainStore = new RetainStore(agentDir);

  // 1. Ambiguous ownership check: staging record
  let record;
  try {
    record = stagingStore.read(revision);
  } catch (error) {
    return {
      status: "refused",
      revision,
      refusalKind: "ambiguous-ownership",
      reason: `corrupt staging record for revision ${revision}: ${error.message}`,
      diagnostic: new WardrobeDiagnostic({
        path: `/remove/${revision}/ownership`,
        reason: `staging record is unreadable: ${error.message}`,
        hint: "corrupt records prevent safe deletion",
      }),
    };
  }
  if (!record) {
    return {
      status: "refused",
      revision,
      refusalKind: "ambiguous-ownership",
      reason: `no staging record exists for revision ${revision}`,
      diagnostic: new WardrobeDiagnostic({
        path: `/remove/${revision}/ownership`,
        reason: "staging record does not exist or cannot be read",
        hint: "an unrecorded directory is not owned by this manager",
      }),
    };
  }

  if (record.planId !== revision) {
    return {
      status: "refused",
      revision,
      refusalKind: "ambiguous-ownership",
      reason: `staging record planId ${JSON.stringify(record.planId)} does not match revision ${JSON.stringify(revision)}`,
      diagnostic: new WardrobeDiagnostic({
        path: `/remove/${revision}/ownership`,
        reason: "staging record names a different revision than its file",
        hint: "ambiguous ownership prevents safe deletion",
      }),
    };
  }

  if (expectedPresetKey) {
    const recordPreset = repositoryKeyOf(record.identity ?? report.preset);
    if (recordPreset !== expectedPresetKey) {
      return {
        status: "refused",
        revision,
        refusalKind: "ambiguous-ownership",
        reason: `revision ${revision} belongs to preset ${recordPreset}, not ${expectedPresetKey}`,
        diagnostic: new WardrobeDiagnostic({
          path: `/remove/${revision}/ownership`,
          reason: `preset mismatch: expected ${expectedPresetKey}, got ${recordPreset}`,
          hint: "ambiguous ownership prevents safe deletion",
        }),
      };
    }
  }

  if (!record.attempts || record.attempts.length === 0) {
    return {
      status: "refused",
      revision,
      refusalKind: "ambiguous-ownership",
      reason: `staging record for revision ${revision} records no attempts`,
      diagnostic: new WardrobeDiagnostic({
        path: `/remove/${revision}/ownership`,
        reason: "staging record records no attempt directories",
        hint: "cannot determine owned path to remove",
      }),
    };
  }

  // 2. Confinement check: stagingRoot and planRoot (staging/<planId>/)
  const stagingRoot = join(agentDir, "wardrobe", "staging");
  const planRoot = join(stagingRoot, revision);
  const attemptDirs = record.attempts.map((a) => a.agentDir);
  try {
    verifyPlanConfinement({ stagingRoot, planId: revision, attemptDirs });
  } catch (error) {
    const isMissing = error.message.includes("does not exist");
    return {
      status: "refused",
      revision,
      refusalKind: isMissing ? "missing-path" : "escaping-symlink",
      reason: isMissing ? error.message : `escaping symlink: ${error.message}`,
      diagnostic: new WardrobeDiagnostic({
        path: isMissing ? `/remove/${revision}/path` : `/remove/${revision}/confinement`,
        reason: error.message,
        hint: isMissing
          ? "missing revisions are diagnosed, not used to delete arbitrary directories"
          : "escaping symlinks are refused; only strictly owned paths may be deleted",
      }),
    };
  }

  // 3. Stale lease check (Refusal with diagnosis, not silent deletion)
  const lease = leaseStore.read(revision);
  if (lease && isStale(lease)) {
    return {
      status: "refused",
      revision,
      refusalKind: "stale-lease",
      reason: `stale lease detected for revision ${revision} (${leaseReason(lease)})`,
      diagnostic: new WardrobeDiagnostic({
        path: `/remove/${revision}/lease`,
        reason: `stale lease: ${leaseReason(lease)}`,
        hint: "stale ownership must be diagnosed and cleared before deletion; it is not silently overridden",
      }),
    };
  }

  // 4. Reference checks (Active lease, running session, strict binding, retain)
  const blockingReferences = [];

  // Active lease
  if (lease && !isStale(lease)) {
    blockingReferences.push({
      kind: "active-lease",
      reason: `revision has an active lease: ${leaseReason(lease)}`,
      hint: "wait for the active process to finish",
    });
  }

  // Running session
  if (session) {
    const runningRev =
      session.baseline?.()?.revision ??
      (session.agentDir ? runningRevisionOf({ agentDir: session.agentDir, reports: [report] })?.revision : null);
    if (runningRev === revision) {
      blockingReferences.push({
        kind: "active-session",
        reason: `revision ${revision} is currently executing this active session`,
        hint: "switch to another revision or run removal from outside the session",
      });
    }
  }

  // Strict binding
  const bindings = bindingStore.list();
  for (const b of bindings) {
    if (b.mode === "strict" && b.revision === revision) {
      blockingReferences.push({
        kind: "strict-binding",
        preset: b.preset,
        reason: `strict binding for preset ${b.preset} pins revision ${revision}`,
        hint: `change binding mode with /wardrobe bind ${b.preset} --mode follow before removing`,
      });
    }
  }

  // Explicit retain
  const retain = retainStore.read(revision);
  if (retain) {
    blockingReferences.push({
      kind: "retain",
      reason: `explicit retention reference exists for revision ${revision}`,
      hint: `release with /wardrobe release ${retain.preset ?? report.preset.id} --revision ${revision} before removing`,
    });
  }

  if (blockingReferences.length > 0) {
    return {
      status: "blocked",
      revision,
      planRoot,
      blockingReferences,
    };
  }

  return {
    status: "removable",
    revision,
    planRoot,
  };
}

/**
 * Perform deletion of one verified removable revision.
 * Includes immediate TOCTOU lease and confinement re-checks before deleting.
 */
export function executeRemovalSingle({ agentDir, revision }) {
  assertSafeId(revision);
  const stagingRoot = join(agentDir, "wardrobe", "staging");
  const planRoot = join(stagingRoot, revision);
  const leaseStore = new LeaseStore(agentDir);
  const stagingStore = new StagingStore(agentDir);
  const planStore = new PlanStore(agentDir);

  // TOCTOU check 1: Active lease right before deletion
  const lease = leaseStore.read(revision);
  if (lease && !isStale(lease)) {
    throw new Error(`cannot delete revision ${revision}: active lease was acquired (${leaseReason(lease)})`);
  }
  if (lease && isStale(lease)) {
    throw new Error(`cannot delete revision ${revision}: stale lease exists (${leaseReason(lease)})`);
  }

  // TOCTOU check 2: Confinement right before deletion
  if (existsSync(planRoot)) {
    verifyPlanConfinement({ stagingRoot, planId: revision });
  }

  // Find transcript files before deleting the directory
  const transcripts = findSessionTranscripts(planRoot);

  stagingStore.delete(revision);
  leaseStore.delete(revision);
  planStore.delete(revision);

  return {
    revision,
    transcripts,
  };
}

/**
 * Execute removal for a preset or a single revision of a preset.
 */
export async function removeRevisions({
  agentDir,
  presetSelector,
  revisionSelector = null,
  session = null,
  env = process.env,
}) {
  const { canonical, target, presetReports, unreadable } = await resolveTarget({
    agentDir,
    presetSelector,
    revisionSelector,
    env,
    commandName: "remove",
  });

  if (target) {
    const evaluation = evaluateRevision({
      agentDir,
      report: target,
      session,
      expectedPresetKey: canonical.presetKey,
    });

    if (evaluation.status === "refused") {
      throw WardrobeError.from(
        evaluation.reason,
        [evaluation.diagnostic],
        evaluation.hint ?? "safety hazard prevents removal"
      );
    }

    if (evaluation.status === "blocked") {
      throw WardrobeError.from(
        `revision ${target.revision} cannot be removed: active references exist`,
        evaluation.blockingReferences.map(
          (b) => new WardrobeDiagnostic({ path: `/remove/${b.kind}`, reason: b.reason, hint: b.hint })
        ),
        "resolve all blocking references before removal"
      );
    }

    const { transcripts } = executeRemovalSingle({ agentDir, revision: target.revision });
    return {
      ok: true,
      command: "remove",
      preset: canonical.presetKey,
      removed: [target.revision],
      scriptExternalEffectsReversed: false,
      transcriptsDestroyed: {
        count: transcripts.length,
        paths: transcripts,
      },
    };
  }

  // Wholesale removal without --revision
  const stagingRoot = join(agentDir, "wardrobe", "staging");
  const unreadableForPreset = [];
  for (const entry of unreadable ?? []) {
    const filePath = join(stagingRoot, entry.file);
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf8");
      if (raw.includes(canonical.presetKey) || raw.includes(presetSelector)) {
        unreadableForPreset.push(entry);
      }
    } catch {}
  }

  if (presetReports.length === 0) {
    if (unreadableForPreset.length > 0) {
      throw WardrobeError.from(
        `cannot remove preset ${canonical.presetKey}: corrupt staging records exist`,
        unreadableForPreset.map(
          (e) =>
            new WardrobeDiagnostic({
              path: `/remove/${e.file}/ownership`,
              reason: `unreadable staging record: ${e.reason}`,
              hint: "ambiguous ownership: corrupt or unreadable staging records block removal",
            })
        ),
        "repair or clear corrupt records before removal"
      );
    }
    throw WardrobeError.from(
      `no installed revisions for preset ${canonical.presetKey}`,
      [],
      "see /wardrobe status for installed revisions"
    );
  }

  const evaluations = presetReports.map((r) =>
    evaluateRevision({ agentDir, report: r, session, expectedPresetKey: canonical.presetKey })
  );

  const nonRemovable = evaluations.filter((e) => e.status !== "removable");
  if (nonRemovable.length > 0 || unreadableForPreset.length > 0) {
    const diagnostics = [];
    for (const e of nonRemovable) {
      if (e.status === "refused") {
        diagnostics.push(e.diagnostic);
      } else {
        for (const b of e.blockingReferences) {
          diagnostics.push(
            new WardrobeDiagnostic({
              path: `/remove/${e.revision}/${b.kind}`,
              reason: b.reason,
              hint: b.hint,
            })
          );
        }
      }
    }
    for (const e of unreadableForPreset) {
      diagnostics.push(
        new WardrobeDiagnostic({
          path: `/remove/${e.file}/ownership`,
          reason: `unreadable staging record: ${e.reason}`,
          hint: "ambiguous ownership: corrupt or unreadable staging records block wholesale removal",
        })
      );
    }
    throw WardrobeError.from(
      `cannot remove preset ${canonical.presetKey}: ${nonRemovable.length + unreadableForPreset.length} revisions cannot be removed or are unreadable`,
      diagnostics,
      "use --revision <id> to delete a specific unreferenced revision, or resolve blocking references first"
    );
  }

  const allTranscripts = [];
  for (const e of evaluations) {
    const { transcripts } = executeRemovalSingle({ agentDir, revision: e.revision });
    allTranscripts.push(...transcripts);
  }

  return {
    ok: true,
    command: "remove",
    preset: canonical.presetKey,
    removed: evaluations.map((e) => e.revision),
    scriptExternalEffectsReversed: false,
    transcriptsDestroyed: {
      count: allTranscripts.length,
      paths: allTranscripts,
    },
  };
}

/**
 * Drop an explicit retention reference for a revision.
 */
export async function releaseRetain({ agentDir, presetSelector, revision, env = process.env }) {
  if (!revision) {
    throw WardrobeError.from(
      "/wardrobe release needs a revision",
      [],
      "usage: /wardrobe release <preset> --revision <revision>"
    );
  }

  const { canonical, target } = await resolveTarget({
    agentDir,
    presetSelector,
    revisionSelector: revision,
    env,
    commandName: "release",
  });

  const retainStore = new RetainStore(agentDir);
  const retain = retainStore.read(target.revision);
  if (!retain) {
    throw WardrobeError.from(
      `revision ${target.revision} has no explicit retention reference`,
      [new WardrobeDiagnostic({ path: `/release/${target.revision}`, reason: "no retain record found" })],
      "only explicitly retained revisions can be released"
    );
  }

  retainStore.delete(target.revision);

  const bindingStore = new BindingStore(agentDir);
  const binding = bindingStore.read(canonical.presetKey);
  const stillStrict = binding?.mode === "strict" && binding?.revision === target.revision;

  return {
    ok: true,
    command: "release",
    preset: canonical.presetKey,
    revision: target.revision,
    released: true,
    stillBlockedByStrict: Boolean(stillStrict),
    scriptExternalEffectsReversed: false,
  };
}

/**
 * Explicitly retain an installed revision.
 */
export async function retainRevision({ agentDir, presetSelector, revision, env = process.env }) {
  if (!revision) {
    throw WardrobeError.from(
      "/wardrobe retain needs a revision",
      [],
      "usage: /wardrobe retain <preset> --revision <revision>"
    );
  }

  const { canonical, target } = await resolveTarget({
    agentDir,
    presetSelector,
    revisionSelector: revision,
    env,
    commandName: "retain",
  });

  const retainStore = new RetainStore(agentDir);
  retainStore.write({
    preset: canonical.presetKey,
    revision: target.revision,
    retainedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    command: "retain",
    preset: canonical.presetKey,
    revision: target.revision,
    retained: true,
  };
}
