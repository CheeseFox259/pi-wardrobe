// Diagnosing an installed revision against its lock.
//
// A revision's record says what the install believed at the time. This module
// re-measures the revision now and reports the difference, so "available" can
// only ever mean the lock still holds.
//
// The states are deliberately not a spectrum of mostly-healthy:
//
//   available  — every measurement still matches the lock.
//   drifted    — measured, and it no longer matches. The revision is not the
//                approved revision; it is refused, not silently accepted as an
//                update, because nothing approved the change.
//   unverified — this host cannot vouch for it: a different toolchain or
//                platform, a measurement that could not be completed, or a plan
//                that is no longer available to compare against.
//   failed     — the install attempt itself failed and was retained as failed.
//   missing    — the revision's directory is gone. What remains is not reported
//                as the original exact revision, and nothing is rebuilt here:
//                reconstructing a tree does not reconstruct the approval.
//
// A differing tree is reported as a difference. There is deliberately no path
// that rebuilds a drifted revision and calls the result the same revision.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  LOCK_SCHEMA,
  lockDigestOf,
  measureRevision,
  presentRuntimeData,
} from "./lock.mjs";
import { digestMatches, digestOf } from "./plan.mjs";
import { supportsPi } from "./semver.mjs";

/** What every state means, reported verbatim so the text can say the same. */
export const STATES = {
  available: "measured against its lock and unchanged",
  drifted: "measured and no longer matches its lock; refused",
  unverified: "cannot be verified on this host; not claimed available",
  failed: "the install attempt failed and was retained as failed",
  missing: "the revision's directory is not there",
};

/**
 * Re-measure one revision.
 *
 * @param {object} record the staging record for this revision
 * @param {{env: object, plan: object|null, attempt?: object|null}} input
 */
export async function diagnoseRevision(record, { env, plan = null, attempt = null } = {}) {
  const latest = attempt ?? record.attempts?.at(-1) ?? null;
  const identity = {
    revision: record.planId,
    source: record.identity?.source ?? null,
    id: record.identity?.id ?? null,
    name: record.declaration?.name ?? null,
    version: record.declaration?.version ?? null,
  };
  const base = {
    revision: record.planId,
    preset: identity,
    // What the install wrote down, kept next to what is observed so the two can
    // never be quietly merged into one claim.
    recorded: record.state,
    launchable: false,
    retained: record.previousAttemptsRetained ?? [],
  };

  if (!latest) {
    return finish({ ...base, latest: null, state: "missing", detail: "no install attempt was recorded" });
  }
  if (!existsSync(latest.agentDir)) {
    return finish({
      ...base,
      latest,
      state: "missing",
      detail: `${latest.agentDir} does not exist; the approved revision is not on disk`,
    });
  }

  const recordedLock = latest.lock ?? null;
  if (latest.state === "failed") {
    // A failed attempt is reported as failed whatever else can be measured:
    // nothing about it was ever verified, so there is nothing to compare a
    // lock against and nothing here claims drift or its absence.
    const measured = await measure({ plan, latest, env, record });
    return finish({
      ...base,
      latest,
      state: "failed",
      detail: latest.failure?.message ?? "the install attempt failed",
      lock: recordedLock ? summariseLock(recordedLock) : null,
      failure: latest.failure ?? null,
      residual: latest.residual ?? [],
      unverified: measured?.unverified ?? [],
      runtimeData: presentRuntimeData(latest.agentDir),
    });
  }

  const measured = await measure({ plan, latest, env, record });
  if (!measured) {
    return finish({
      ...base,
      latest,
      state: "unverified",
      detail: "the approved plan is no longer available, so this revision cannot be re-measured",
      lock: recordedLock ? summariseLock(recordedLock) : null,
      runtimeData: presentRuntimeData(latest.agentDir),
    });
  }

  if (!recordedLock) {
    return finish({
      ...base,
      latest,
      state: "unverified",
      detail: "this revision was installed without a lock, so it cannot be verified",
      lock: null,
      observed: measured.summary,
      unverified: [
        {
          component: "lock",
          reason: "no lock was recorded for this attempt",
          detail: "an installation without a lock cannot be reported as the approved revision",
        },
      ],
      runtimeData: presentRuntimeData(latest.agentDir),
    });
  }

  const drift = [];
  const unverified = [...measured.unverified];

  if (recordedLock.schemaVersion !== LOCK_SCHEMA) {
    drift.push({
      component: "lock",
      path: "/lock/schemaVersion",
      expected: recordedLock.schemaVersion,
      found: LOCK_SCHEMA,
      detail: "the lock format changed; this lock cannot be compared to a new measurement",
    });
  } else {
    drift.push(...configurationDrift(recordedLock.configuration, measured.configuration, plan));
    drift.push(...resourceDrift(recordedLock.resources, measured.lock.resources));
    drift.push(...codeDrift(recordedLock.code, measured.lock.code));
    unverified.push(...baselineUnverified(recordedLock.baseline, measured.lock.baseline));
    unverified.push(...environmentUnverified(plan, measured.lock.baseline));
  }

  const state = drift.length
    ? "drifted"
    : unverified.length || measured.problems.length
      ? "unverified"
      : "available";

  return finish({
    ...base,
    latest,
    state,
    detail: STATES[state],
    lock: summariseLock(recordedLock),
    observed: measured.summary,
    drift,
    unverified: [
      ...unverified,
      ...measured.problems.map((problem) => ({
        component: "measurement",
        reason: problem.reason,
        detail: `could not measure ${problem.path}`,
      })),
    ],
    runtimeData: presentRuntimeData(latest.agentDir),
  });
}

/** Re-measure, resolving installed paths against the attempt directory. */
async function measure({ plan, latest, env, record }) {
  if (!plan) return null;
  const inventory = (latest.installed ?? []).map((entry) => ({
    ...entry,
    // The recorded absolute path is only trusted when it is still inside this
    // revision; a moved or copied directory must not be measured through
    // someone else's tree.
    installedPath: entry.installedRelative
      ? join(latest.agentDir, entry.installedRelative)
      : entry.installedPath,
  }));
  const { lock, problems } = await measureRevision({ plan, attemptDir: latest.agentDir, inventory, env });
  const unverified = [];
  if (plan.digest !== record.digest) {
    unverified.push({
      component: "configuration",
      reason: "the stored plan no longer matches the digest the install recorded",
      detail: `installed against ${record.digest?.slice(0, 16) ?? "(none)"}, stored plan is ${plan.digest?.slice(0, 16) ?? "(none)"}`,
    });
  }
  return {
    lock,
    problems,
    configuration: lock.configuration,
    unverified,
    summary: {
      configurationDigest: lock.configuration.digest,
      lockDigest: lockDigestOf(lock),
      code: {
        digest: lock.code.digest,
        roots: lock.code.roots,
        files: lock.code.files,
        bytes: lock.code.bytes,
        packages: lock.code.packages,
        excluded: lock.code.excluded,
        excludedCount: lock.code.excludedCount,
      },
      resources: lock.resources.length,
      baseline: lock.baseline,
    },
  };
}

/** Configuration differences, named rather than only detected. */
function configurationDrift(recorded, observed, plan) {
  const drift = [];
  if (recorded.digest !== observed.digest) {
    drift.push({
      component: "configuration",
      path: "/lock/configuration",
      expected: recorded.digest,
      found: observed.digest,
      detail: configurationDetail(recorded.content, observed.content),
    });
  }
  // The recorded plan is the approval. If it no longer hashes to its own
  // digest, the configuration this revision was built from is not the one a
  // user approved.
  if (plan && !digestMatches(plan)) {
    drift.push({
      component: "configuration",
      path: "/plan/digest",
      expected: plan.digest,
      found: digestOf(plan),
      detail: "the stored plan no longer hashes to its digest",
    });
  }
  return drift;
}

function configurationDetail(expected, observed) {
  const differences = [];
  for (const field of ["identity", "declaration", "sources", "selectors", "runtime", "persona"]) {
    if (digestOf(expected?.[field] ?? null) === digestOf(observed?.[field] ?? null)) continue;
    differences.push(field);
  }
  return differences.length
    ? `changed: ${differences.join(", ")}`
    : "the recorded configuration content and its digest disagree";
}

/** Resource content differences, per selected path. */
function resourceDrift(recorded, observed) {
  const key = (entry) => `${entry.package}/${entry.kind}/${entry.path}`;
  const expected = new Map(recorded.map((entry) => [key(entry), entry.sha256]));
  const found = new Map(observed.map((entry) => [key(entry), entry.sha256]));
  const drift = [];

  for (const [name, sha] of expected) {
    if (!found.has(name)) {
      drift.push({
        component: "resources",
        path: `/lock/resources/${name}`,
        expected: sha,
        found: null,
        detail: "a locked selected resource is no longer there",
      });
      continue;
    }
    if (found.get(name) !== sha) {
      drift.push({
        component: "resources",
        path: `/lock/resources/${name}`,
        expected: sha,
        found: found.get(name),
        detail: "the selected resource's content changed",
      });
    }
  }
  for (const name of found.keys()) {
    if (expected.has(name)) continue;
    drift.push({
      component: "resources",
      path: `/lock/resources/${name}`,
      expected: null,
      found: found.get(name),
      detail: "a resource is selected that the approved configuration did not name",
    });
  }
  return drift;
}

/** Code differences, narrowed to the packages that moved. */
function codeDrift(recorded, observed) {
  if (recorded.digest === observed.digest) return [];
  const drift = [
    {
      component: "code",
      path: "/lock/code",
      expected: recorded.digest,
      found: observed.digest,
      detail: "the installed dependency tree is not the tree that was locked",
    },
  ];
  const expected = recorded.packages ?? {};
  const found = observed.packages ?? {};
  for (const group of new Set([...Object.keys(expected), ...Object.keys(found)])) {
    if (expected[group] === found[group]) continue;
    drift.push({
      component: "code",
      path: `/lock/code/packages/${group}`,
      expected: expected[group] ?? null,
      found: found[group] ?? null,
      detail:
        expected[group] === undefined
          ? "a package that was not locked is installed"
          : found[group] === undefined
            ? "a locked package is no longer installed"
            : "this package's contents changed",
    });
  }
  return drift;
}

/**
 * A different toolchain is not silently equivalent.
 *
 * The measurements still hold, so this is not drift: the revision is simply not
 * verified *here*, and saying so is the honest answer.
 */
function baselineUnverified(expected, observed) {
  const unverified = [];
  for (const field of ["pi", "node", "npm", "platform", "arch"]) {
    const locked = expected?.[field] ?? null;
    const here = observed?.[field] ?? null;
    if (locked === here || field==='pi' && locked && supportsPi('>='+locked,here)===true) continue;
    unverified.push({
      component: "baseline",
      reason: `this host runs ${field} ${here ?? "unknown"}, the revision was locked on ${locked ?? "unknown"}`,
      detail: `${field} differs: locked ${locked ?? "(none)"}, observed ${here ?? "(none)"}`,
    });
  }
  return unverified;
}

/**
 * Whether this host is one the revision declares itself for.
 *
 * A declaration narrows support; it does not certify an untested runtime. A
 * range that cannot be resolved, and a Pi build that cannot be identified, are
 * both reported as unanswerable rather than quietly treated as satisfied.
 */
function environmentUnverified(plan, baseline) {
  const unverified = [];
  const compatibility = plan?.declaration?.compatibility ?? null;
  if (!compatibility) return unverified;

  const range = compatibility.pi ?? null;
  if (range) {
    if (!baseline?.pi) {
      unverified.push({
        component: "compatibility",
        reason: `the Pi build here is unknown, so ${range} cannot be checked`,
        detail: "an unchecked compatibility range is not a satisfied range",
      });
    } else {
      const resolved = supportsPi(range, baseline.pi);
      if (resolved === null) {
        unverified.push({
          component: "compatibility",
          reason: `cannot resolve ${range} against Pi ${baseline.pi}`,
          detail: "an unresolvable compatibility range is not a satisfied range",
        });
      } else if (!resolved) {
        unverified.push({
          component: "compatibility",
          reason: `Pi ${baseline.pi} does not satisfy the declared range ${range}`,
          detail: "the revision is unsupported on this host",
        });
      }
    }
  }

  const platforms = compatibility.platforms ?? [];
  if (platforms.length > 0) {
    const here = baseline?.platform && baseline?.arch ? `${baseline.platform}-${baseline.arch}` : null;
    const supported = here !== null && platforms.some((entry) => entry === here || entry === baseline.platform);
    if (!supported) {
      unverified.push({
        component: "compatibility",
        reason: `this host (${here ?? "unknown platform"}) is not among the declared platforms (${platforms.join(", ")})`,
        detail: "the revision is unsupported on this host",
      });
    }
  }
  return unverified;
}

/** The report form of a lock: hashes and counts, never file contents. */
export function summariseLock(lock) {
  if (!lock) return null;
  return {
    schemaVersion: lock.schemaVersion,
    digest: lockDigestOf(lock),
    configuration: { digest: lock.configuration.digest },
    code: {
      digest: lock.code.digest,
      roots: lock.code.roots ?? [],
      files: lock.code.files,
      bytes: lock.code.bytes,
      packages: lock.code.packages ?? {},
      excluded: lock.code.excluded ?? [],
      excludedCount: lock.code.excludedCount ?? 0,
    },
    baseline: lock.baseline,
    resources: lock.resources.map((entry) => ({
      package: entry.package,
      kind: entry.kind,
      path: entry.path,
      sha256: entry.sha256,
    })),
    runtimeData: lock.runtimeData ?? [],
  };
}

function finish(report) {
  return { drift: [], unverified: [], runtimeData: [], lock: null, observed: null, ...report };
}

/** One line of truth per revision, for list and status. */
export function oneLine(report) {
  const state = report.state;
  return {
    revision: report.revision,
    preset: report.preset,
    recorded: report.recorded,
    state,
    launchable: report.launchable,
    lock: report.lock?.digest ?? null,
    drift: report.drift?.length ?? 0,
    unverified: report.unverified?.length ?? 0,
  };
}
