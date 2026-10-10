// Reading installed revisions back out of owned storage.
//
// Records live under this manager's own staging directory; the plan each one
// was built from lives beside them. Both are read here so every command —
// list, status, doctor, and the launcher — answers from the same measured
// state rather than from what a record claimed when it was written.

import { PlanStore } from "./approval.mjs";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { diagnoseRevision } from "./doctor.mjs";
import { identityKey } from "./identity.mjs";
import { StagingStore } from "./staging.mjs";

/**
 * Every record this agent directory holds, with the plan each one needs.
 *
 * A missing or unreadable plan is not an error: it becomes `null`, which the
 * doctor reports as unverifiable. Refusing to answer at all would hide the
 * revisions that can still be answered for.
 */
export function revisionStore(agentDir) {
  const store = new StagingStore(agentDir);
  const plans = new PlanStore(agentDir);
  const { records, unreadable } = store.list();
  return {
    records,
    unreadable,
    plans: new Map(
      records.map((record) => {
        try {
          return [record.planId, plans.read(record.planId)];
        } catch {
          return [record.planId, null];
        }
      })
    ),
  };
}

/** Diagnose every record, in stored order. */
export async function diagnoseAll(agentDir, { env }) {
  const { records, unreadable, plans } = revisionStore(agentDir);
  const reports = [];
  for (const record of records) {
    reports.push(
      await diagnoseRevision(record, { env, plan: plans.get(record.planId) ?? null })
    );
  }
  return { reports, unreadable };
}

/** Diagnose the revisions belonging to one preset identity. */
export async function diagnosePreset(agentDir, presetKey, { env }) {
  const { reports, unreadable } = await diagnoseAll(agentDir, { env });
  return {
    reports: reports.filter((report) => identityKey(report.preset) === presetKey),
    unreadable,
  };
}

/**
 * One revision from an already-measured set, addressed by revision id, preset
 * identity or preset name.
 *
 * An unknown or ambiguous selector is refused with the names that do exist,
 * because guessing which revision a user meant is exactly the mistake this
 * manager exists to prevent.
 */
export function selectRevision(reports, selector, { unreadable = [] } = {}) {
  const matches = reports.filter((report) => revisionMatches(report, selector));
  if (matches.length === 0) {
    throw WardrobeError.from(
      `no installed revision matches ${JSON.stringify(selector)}`,
      [
        new WardrobeDiagnostic({
          path: "/revisions",
          reason:
            reports.length === 0
              ? "no revision has been installed in this agent directory"
              : `known revisions: ${reports.map((report) => report.revision).join(", ")}`,
        }),
        ...unreadable.map((entry) =>
          new WardrobeDiagnostic({
            path: `/revisions/${entry.file}`,
            reason: entry.reason,
          })
        ),
      ],
      "see /wardrobe status for what is installed and what state each revision is in"
    );
  }
  if (matches.length > 1) {
    throw WardrobeError.from(
      `${matches.length} revisions match ${JSON.stringify(selector)}`,
      matches.map(
        (report) =>
          new WardrobeDiagnostic({
            path: "/revisions",
            reason: `${report.revision}  ${report.preset.name ?? ""} ${report.preset.version ?? ""}`.trim(),
          })
      ),
      "address one revision by its revision id"
    );
  }
  return matches[0];
}


function revisionMatches(report, selector) {
  const wanted = selector.trim();
  if (report.revision === wanted) return true;
  if (identityKey(report.preset) === wanted) return true;
  return (report.preset.name ?? "") === wanted;
}
