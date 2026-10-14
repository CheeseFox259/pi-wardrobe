// Reading installed revisions back out of owned storage.
//
// Records live under this manager's own staging directory; the plan each one
// was built from lives beside them. Both are read here so every command —
// list, status, doctor, and the launcher — answers from the same measured
// state rather than from what a record claimed when it was written.

import { PlanStore } from "./approval.mjs";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { diagnoseRevision } from "./doctor.mjs";
import { identityKey, repositoryKeyOf } from "./identity.mjs";
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

/**
 * Diagnose every record, in stored order.
 *
 * The plans each revision was built from come back with the reports: a caller
 * that goes on to launch a revision needs the plan it was measured against, and
 * re-reading the store for it would be a second, racy read.
 */
export async function diagnoseAll(agentDir, { env = process.env } = {}) {
  const { records, unreadable, plans } = revisionStore(agentDir);
  const reports = [];
  for (const record of records) {
    reports.push(
      await diagnoseRevision(record, { env, plan: plans.get(record.planId) ?? null })
    );
  }
  return { reports, unreadable, plans };
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


/**
 * The canonical identity of one preset, from whatever the user named.
 *
 * A short key is accepted only while it is unambiguous: two revisions of the
 * same declared id from different sources are different presets, and a binding
 * that guessed between them would pin the wrong one.
 *
 * @returns {{ok: true, presetKey: string} | {ok: false, reason: string, candidates: string[]}}
 */
export function resolvePresetKey(selector, reports) {
  // A key printed elsewhere may still carry its pin; a preset is its
  // repository, so the pin is dropped before anything is compared.
  const wanted = repositoryKeyOf({ source: String(selector).trim(), id: "" }).replace(/#$/, "");
  const exact = reports.filter((report) => repositoryKeyOf(report.preset) === wanted);
  if (exact.length > 0) return { ok: true, presetKey: wanted };
  const candidates = reports.filter(
    (report) => report.preset.id === wanted || report.preset.name === wanted
  );
  const distinct = [...new Set(candidates.map((report) => repositoryKeyOf(report.preset)))];
  if (distinct.length === 1) return { ok: true, presetKey: distinct[0] };
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `${wanted} names ${distinct.length} presets`,
      candidates: distinct.sort(),
    };
  }
  return { ok: false, reason: `no installed revision matches ${JSON.stringify(wanted)}`, candidates: [] };
}

function revisionMatches(report, selector) {
  const wanted = selector.trim();
  if (report.revision === wanted) return true;
  if (identityKey(report.preset) === wanted) return true;
  return (report.preset.name ?? "") === wanted;
}
