// The running session's own state.
//
// What a session has been told to prefer lives in the session's own entries, so
// it follows the active branch: a fork inherits it, and abandoned branches stay
// abandoned rather than contributing preferences to the branch the user is
// actually on.
//
// Nothing here is a revision, a lock or a retained binding. A preference is
// cheap and disposable; only the code it was applied to is reviewed and
// installed, which is why a preference can be reapplied to a process and never
// to a directory.

/** The custom-entry type a session's own state is stored under. */
export const SESSION_TYPE = "wardrobe.session";

/**
 * The state on the active branch, or an empty one.
 *
 * The branch is the authority: an entry on an abandoned branch is an
 * alternative history, not a preference the user is living with.
 */
export function sessionStateOf(entries) {
  const mine = entries.filter((entry) => entry.type === "custom" && entry.customType === SESSION_TYPE);
  if (mine.length === 0) return emptyState();
  const last = mine.at(-1);
  const data = last.data ?? {};
  return {
    revision: data.revision ?? null,
    appliedAt: data.appliedAt ?? null,
    runId: data.runId ?? null,
    tools: data.tools ?? [],
    model: data.model ?? null,
    thinking: data.thinking ?? null,
    persona: data.persona ?? [],
    ...data,
  };
}

function emptyState() {
  return {
    revision: null,
    appliedAt: null,
    runId: null,
    tools: [],
    model: null,
    thinking: null,
    persona: [],
  };
}

/**
 * The revision this process is running, if any.
 *
 * Decided by asking which revision's own directory this process was started
 * with. A personal agent directory belongs to no revision, and saying so is the
 * answer: there is nothing here for a preference to be applied on top of.
 */
export function runningRevisionOf({ agentDir, reports }) {
  if (!agentDir) return null;
  const match = reports.find((report) => report.latest?.agentDir === agentDir);
  return match ?? null;
}

/**
 * The parts of a revision a running process cannot change.
 *
 * Installed code is compared per package rather than as one whole-tree digest.
 * A tree digest covers the installer metadata beside the packages, and npm's
 * lockfile records the directory it was installed into, so two installations of
 * identical content in different revision directories carry different digests.
 * The per-package digests answer the question a running process actually cares
 * about: is this the same code?
 */
export function executableShapeOf({ report, plan }) {
  return {
    packages: (plan.installationSurfaces ?? []).map((surface) => ({
      alias: surface.alias,
      source: surface.source,
    })),
    code: packageDigestsOf(report.lock),
    resources: (plan.resourceSelectors ?? []).flatMap((selector) =>
      (selector.loaded ?? []).map((path) => ({
        package: selector.package,
        kind: selector.kind,
        path,
      }))
    ),
  };
}

/**
 * Per-package code digests, without the installer metadata around them.
 *
 * The metadata group is dropped deliberately and is named here so nobody reads
 * its absence as an oversight: it describes where a revision was installed, not
 * what it contains.
 */
export function packageDigestsOf(lock) {
  const groups = lock?.code?.packages ?? {};
  return Object.fromEntries(
    Object.entries(groups)
      .filter(([group]) => !group.includes("installer metadata"))
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

/**
 * What the process is actually running right now.
 *
 * Read from the runtime rather than from what was last requested, so a change
 * that was refused, clamped or never applied cannot be reported as applied.
 */
export function effectiveStateOf({
  tools,
  model,
  thinking,
  persona,
  runningRevision = null,
  adoptedFrom = null,
}) {
  return {
    tools: [...(tools ?? [])].sort(),
    model: model ? `${model.provider}/${model.id}` : null,
    thinking: thinking ?? null,
    persona: [...(persona ?? [])],
    runningRevision,
    adoptedFrom,
  };
}

/**
 * Applied beside intended, which is the difference `status` and `explain` owe
 * the user: a preference that was asked for and a preference that is in effect
 * are not the same fact.
 */
export function appliedAgainst({ intended, effective }) {
  const rows = [
    { field: "tools", intended: intended.tools, effective: effective.tools },
    { field: "model", intended: intended.model, effective: effective.model },
    { field: "thinking", intended: intended.thinking, effective: effective.thinking },
    { field: "persona", intended: intended.persona, effective: effective.persona },
  ];
  return rows.map((row) => {
    const same = JSON.stringify(row.intended ?? null) === JSON.stringify(row.effective ?? null);
    // Membership, not a search through a serialisation: an instruction that is
    // a substring of another is still a different instruction.
    const present = new Set(
      Array.isArray(row.effective) ? row.effective.map((entry) => JSON.stringify(entry)) : []
    );
    const missing = Array.isArray(row.intended)
      ? row.intended.filter((entry) => !present.has(JSON.stringify(entry)))
      : [];
    return {
      ...row,
      applied: same,
      // What is intended and not in effect, named rather than left to be
      // inferred from a false "applied". A value the runtime clamped, or a
      // preference it refused, is `different` — never `applied`.
      notApplied: missing,
      status: same ? "in-effect" : missing.length ? "partly-applied" : "different",
    };
  });
}
