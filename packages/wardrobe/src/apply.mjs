// Deciding whether a `use` can be applied inside the running session.
//
// `use` has two jobs and it must never blur them. A difference in tools
// preference, thinking level or appended instructions is a preference the
// running process can adopt. A difference in packages, resources or code is not:
// those were reviewed and installed as a revision, and changing them is a new
// process.
//
// This module decides which of the two a request is. It takes plain data and
// returns plain data, so the decision can be checked without starting a Pi and
// without one: no API here reads or writes anything.

/**
 * What two revisions would change that a running process cannot change.
 *
 * A difference here is not a preference: it is code, a package, or a resource
 * that was reviewed and installed as part of a revision, and adopting it means a
 * new process.
 */
export function executableDifference({ current, target }) {
  const differences = [];
  if (!current) {
    // No revision is running, so any installed code is a difference.
    differences.push({
      kind: "revision",
      detail: "this session is not running an installed revision",
    });
  } else {
    if (JSON.stringify(current.agent ?? null) !== JSON.stringify(target.agent ?? null)) differences.push({ kind: "resource", detail: "agent files or startup settings would change" });
    for (const [group, digest] of Object.entries(target.code)) {
      if (current.code[group] !== digest) {
        differences.push({
          kind: "code",
          detail: `${group} is not the code this session is running`,
        });
      }
    }
    for (const group of Object.keys(current.code)) {
      if (!(group in target.code)) {
        differences.push({ kind: "code", detail: `${group} would stop being loaded` });
      }
    }
    for (const change of packageDifferences(current, target)) differences.push(change);
    for (const change of resourceDifferences(current, target)) differences.push(change);
  }
  return differences;
}

function packageDifferences(current, target) {
  const left = new Map(current.packages.map((entry) => [entry.alias, `${entry.source}#${entry.resourceRoot ?? ""}`]));
  const right = new Map(target.packages.map((entry) => [entry.alias, `${entry.source}#${entry.resourceRoot ?? ""}`]));
  const changes = [];
  for (const [alias, source] of right) {
    if (!left.has(alias)) changes.push({ kind: "package", detail: `${alias} (${source}) would be installed` });
    else if (left.get(alias) !== source) {
      changes.push({ kind: "package", detail: `${alias} would change from ${left.get(alias)} to ${source}` });
    }
  }
  for (const alias of left.keys()) {
    if (right.has(alias)) continue;
    changes.push({ kind: "package", detail: `${alias} would stop being loaded` });
  }
  return changes;
}

function resourceDifferences(current, target) {
  const key = (entry) => `${entry.package}/${entry.kind}/${entry.path}`;
  const left = new Map(current.resources.map((entry) => [key(entry), entry]));
  const right = new Map(target.resources.map((entry) => [key(entry), entry]));
  const changes = [];
  for (const [name] of right) {
    if (!left.has(name)) changes.push({ kind: "resource", detail: `${name} would start loading` });
  }
  for (const [name] of left) {
    if (!right.has(name)) changes.push({ kind: "resource", detail: `${name} would stop loading` });
  }
  return changes;
}

/**
 * What applying a soft change would actually do.
 *
 * `available` is what the process has registered, so a name a preset asks for
 * that nothing provides is reported rather than written into the selection and
 * then quietly missing. The same applies to a name the user or the CLI
 * excluded: it is never re-enabled here, however the preset asked for it.
 */
export function planTools({ wanted, current, available }) {
  const known = new Set(available);
  const present = new Set(current);
  const add = [];
  const remove = [];
  const unmet = [];

  // A restriction the user or the CLI placed is above this layer. Asking for
  // the tool again is a preference this manager cannot honour, and saying so is
  // the only honest answer.
  const restricted = new Set(wanted.restricted ?? []);
  for (const entry of wanted.enabled ?? []) {
    if (restricted.has(entry.tool)) {
      unmet.push({ tool: entry.tool, reason: "the user or CLI excluded this tool; a preset cannot re-enable it" });
      continue;
    }
    if (!known.has(entry.tool)) {
      unmet.push({ tool: entry.tool, reason: "no registered tool has this name here" });
      continue;
    }
    if (!present.has(entry.tool)) add.push(entry.tool);
  }
  for (const entry of wanted.disabled ?? []) {
    if (!present.has(entry.tool)) continue;
    remove.push(entry.tool);
  }

  // `wanted` is the declared selection, whatever this runtime can actually
  // provide. Reporting it as intended is what makes a name that could not take
  // show up as not applied, rather than quietly vanishing from the comparison.
  const wantedNames = [...present].filter((name) => !remove.includes(name));
  for (const entry of wanted.enabled ?? []) {
    if (!wantedNames.includes(entry.tool)) wantedNames.push(entry.tool);
  }
  return {
    enabled: (wanted.enabled ?? []).map((entry) => entry.tool),
    disabled: (wanted.disabled ?? []).map((entry) => entry.tool),
    restricted: wanted.restricted ?? [],
    add: add.sort(),
    remove: remove.sort(),
    unmet,
    intended: wantedNames.sort(),
    resulting: [...present].concat(add).filter((name) => !remove.includes(name)).sort(),
    changed: add.length > 0 || remove.length > 0,
  };
}

/**
 * The thinking level, as an intention.
 *
 * Whether the runtime actually takes it is not knowable here — Pi clamps a
 * level to what the selected model supports — so the answer is read back after
 * it is applied and reported as the difference it turned out to be.
 */
export function planThinking({ preference, effective }) {
  const wanted = preference?.value ?? null;
  if (!wanted) return { requested: null, applies: false, effective, changed: false };
  if (effective === wanted) return { requested: wanted, applies: false, effective, changed: false };
  return {
    requested: wanted,
    applies: true,
    effective,
    changed: true,
    layer: preference.layer ?? null,
  };
}

/**
 * Instructions to append, never to replace.
 *
 * A declaration's `persona.append` arrives folded with its provenance, and the
 * text is what a prompt takes, so that is what is compared here.
 *
 * `active` is what this session has already appended; only the difference is
 * added, and the order is the plan's, so two applications do not duplicate each
 * other's text.
 */
export function planPersona({ wanted, active }) {
  const target = (wanted ?? []).map((entry) => (typeof entry === "string" ? entry : entry.text));
  const already = new Set(active ?? []);
  // Appending never deletes. An instruction an earlier revision contributed, or
  // a user typed into this session, stays in the prompt; the target can only add
  // to it. Removing one would be a replacement, which this layer may not do.
  const retained = [...(active ?? [])];
  const append = target.filter((line) => !already.has(line));
  return {
    append,
    retained,
    resulting: [...retained, ...append],
    changed: append.length > 0,
  };
}

/**
 * Why a soft change cannot be applied right now.
 *
 * Refusing is the honest answer during a turn or a compaction: half-applying a
 * preference mid-run is exactly the mutation this boundary exists to prevent.
 */
export function idleRefusal({ idle, compacting }) {
  if (compacting) {
    return "this session is compacting; apply the change when it has settled";
  }
  if (!idle) {
    return "this session is mid-turn; apply the change when it is idle";
  }
  return null;
}
