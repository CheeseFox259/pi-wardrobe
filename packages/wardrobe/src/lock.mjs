// The revision lock.
//
// A revision is only the revision that was approved while its lock still
// describes what is on disk. The lock is four independent measurements,
// because they fail in different ways:
//
//   configuration — the canonical effective configuration that was approved:
//     identity, exact sources, resource selection, runtime and persona. It
//     carries no timestamps and no credentials, so the same approval always
//     hashes the same.
//   resources — the content hash of every resource the plan actually selects.
//   code — a fingerprint of the installed dependency tree, which is what makes
//     a mutated or differently reconstructed installation detectable.
//   baseline — the Pi, Node, npm and platform the revision was verified on.
//
// A fingerprint deliberately omits Git internals: they move on their own
// (index refresh, gc, rebase) and say nothing about the code that was
// installed. It omits credential files: they are not code, and a fingerprint is
// reported to the user, so a secret must never end up inside one. Declared
// mutable runtime data lives outside the locked code root — it is listed, never
// hashed, so writing to it is not mistaken for code drift.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { digestOf } from "./plan.mjs";
import { run } from "./proc.mjs";

/** The shape version of a lock. A different shape is a different lock. */
export const LOCK_SCHEMA = 1;

/**
 * The installed code roots, relative to one attempt directory.
 *
 * Pi installs npm sources under `npm/` and Git checkouts under `git/`, each
 * with its own installer metadata beside the packages themselves. Both are
 * installed code, so both are locked.
 */
export const CODE_ROOTS = ["npm", "git"];

/** How many excluded paths a lock names before it only counts the rest. */
const EXCLUSION_LIMIT = 50;

/** Files that are credentials wherever they appear inside a code root. */
const CREDENTIAL =
  /^(auth\.json|\.netrc|\.npmrc|\.env(\..+)?|credentials(\..+)?|.*\.(pem|key|p12|pfx))$/;

/**
 * What a fingerprint never covers.
 *
 * Each rule names its reason, so a doctor report can say why a path moved
 * without the fingerprint noticing.
 */
export const EXCLUSIONS = [
  {
    name: "git internals",
    reason: "a checkout's .git directory moves on its own and is not installed code",
    // Directories are skipped rather than filtered afterwards, so a checkout's
    // object store is never read just to be discarded.
    directory: (parts) => parts.at(-1) === ".git",
    test: (parts) => parts.includes(".git"),
  },
  {
    name: "credentials",
    reason: "a credential is not code and must never reach a reported fingerprint",
    test: (parts) => CREDENTIAL.test(parts.at(-1)),
  },
];

/**
 * The canonical effective configuration a plan approves.
 *
 * Exactly the values that decide what a revision *is*: which exact sources it
 * installs, which resources it selects, and the runtime and persona it
 * proposes. Nothing here is a timestamp, a path on this machine, or a secret,
 * so the same approval always produces the same digest.
 */
export function configurationOf(plan) {
  return {
    identity: plan.identity,
    declaration: {
      name: plan.declaration?.name ?? null,
      version: plan.declaration?.version ?? null,
      schemaVersion: plan.declaration?.schemaVersion ?? null,
      compatibility: plan.declaration?.compatibility ?? null,
    },
    sources: plan.installationSurfaces.map((surface) => ({
      alias: surface.alias,
      source: surface.source,
      artifact: surface.artifact ?? null,
      installsCode: surface.installsCode === true,
    })),
    selectors: plan.resourceSelectors.map((selector) => ({
      package: selector.package,
      kind: selector.kind,
      include: [...(selector.include ?? [])].sort(),
      exclude: [...(selector.exclude ?? [])].sort(),
      loaded: [...(selector.loaded ?? [])].sort(),
    })),
    runtime: plan.runtime ?? null,
    persona: plan.persona ?? null,
  };
}

/**
 * Measure one installed revision.
 *
 * `inventory` is the installed package list Pi reported, so a resource is
 * hashed where Pi actually put it rather than where this manager assumes it
 * lives. Anything that cannot be measured comes back as a problem instead of
 * being guessed at: an incomplete measurement cannot support an available
 * claim.
 *
 * @returns {Promise<{lock: object, problems: Array<{path: string, reason: string}>}>}
 */
export async function measureRevision({ plan, attemptDir, inventory, env }) {
  const configuration = configurationOf(plan);
  const resources = resourceFingerprints(plan, inventory);
  const code = codeFingerprint(attemptDir, inventory);
  const baseline = await baselineOf(env);

  const problems = [
    ...resources.problems,
    // A preset that installs nothing has no code root and needs none; a preset
    // that installs packages must have one to lock.
    ...(plan.installationSurfaces.length > 0 && code.roots.length === 0
      ? [{ path: "/code", reason: "the plan installs packages, but no installed code root is there" }]
      : []),
    // An incomplete baseline cannot support an availability claim: a revision
    // verified against an unknown toolchain was verified against nothing.
    ...(baseline.pi === null
      ? [{ path: "/baseline/pi", reason: "the Pi build could not be identified here" }]
      : []),
    ...(baseline.npm === null
      ? [{ path: "/baseline/npm", reason: "the npm version could not be read on this host" }]
      : []),
  ];

  const lock = {
    schemaVersion: LOCK_SCHEMA,
    configuration: { digest: digestOf(configuration), content: configuration },
    resources: resources.entries,
    code,
    baseline,
    // Declared mutable runtime data. It sits outside the code root, so writing
    // to it cannot move a fingerprint; it is named so status can show what a
    // revision is allowed to change.
    runtimeData: runtimeDataRoots(),
  };
  return { lock, problems };
}

/** One fingerprint for a whole lock, for reporting and comparison. */
export function lockDigestOf(lock) {
  return digestOf({
    schemaVersion: lock.schemaVersion,
    configuration: lock.configuration.digest,
    resources: lock.resources.map((entry) => [
      entry.package,
      entry.kind,
      entry.path,
      entry.sha256,
    ]),
    code: lock.code.digest,
    baseline: lock.baseline,
  });
}

/**
 * The declared runtime data of a revision.
 *
 * Sessions, leases and the manager's own records live here. None of it is
 * locked code, and none of it is hashed.
 */
function runtimeDataRoots() {
  return [
    { path: "sessions", mutable: true, why: "explicit session directories" },
    { path: "wardrobe", mutable: true, why: "this manager's own records for the revision" },
  ];
}

/** Runtime data roots that exist right now, reported without being read. */
export function presentRuntimeData(attemptDir) {
  return runtimeDataRoots()
    .filter((root) => existsSync(join(attemptDir, root.path)))
    .map((root) => root.path);
}

// ---------------------------------------------------------------------------
// Resources

/** Content hashes for exactly the resources the plan selects. */
function resourceFingerprints(plan, inventory) {
  const entries = [];
  const problems = [];
  const seen = new Set();

  for (const selector of plan.resourceSelectors ?? []) {
    const installed = inventory.find((entry) => entry.alias === selector.package);
    const loaded = selector.loaded ?? [];
    if (!installed?.installedPath) {
      if (loaded.length > 0) {
        problems.push({
          path: `/resourceSelectors/${selector.package}`,
          reason: `no installed package to hash ${loaded.length} selected resource(s) against`,
        });
      }
      continue;
    }
    for (const path of loaded) {
      const key = `${selector.package}:${selector.kind}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hashed = hashResource(join(installed.installedPath, path));
      if (hashed.error) {
        problems.push({ path: `/resourceSelectors/${selector.package}`, reason: hashed.error });
        continue;
      }
      entries.push({
        package: selector.package,
        kind: selector.kind,
        path,
        sha256: hashed.sha256,
        bytes: hashed.bytes,
      });
    }
  }

  return {
    entries: entries.sort((a, b) =>
      `${a.package}/${a.kind}/${a.path}`.localeCompare(`${b.package}/${b.kind}/${b.path}`)
    ),
    problems,
  };
}

function hashResource(absolute) {
  let info;
  try {
    info = statSync(absolute);
  } catch {
    return { error: `selected resource ${absolute} is not present` };
  }
  if (info.isDirectory()) {
    // A selector may name a directory; the whole tree is then the resource.
    // The exclusions apply here too: a credential inside a selected directory
    // must not be read to build a fingerprint that gets reported.
    const files = walk(absolute, "").filter(
      (entry) => entry.kind === "file" && !EXCLUSIONS.some((rule) => rule.test(entry.path.split("/")))
    );
    if (files.length === 0) return { error: `selected resource ${absolute} is empty` };
    return {
      sha256: digestOf(files.map((entry) => [entry.path, entry.sha256])),
      bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    };
  }
  if (!info.isFile()) {
    return { error: `selected resource ${absolute} is not a readable file or directory` };
  }
  if (EXCLUSIONS.some((rule) => rule.test(absolute.split(/[/\\]/)))) {
    // Selecting an excluded path is refused rather than quietly skipped: the
    // review said a resource would load, and a fingerprint cannot speak for one.
    return { error: `selected resource ${absolute} is a path a fingerprint never covers` };
  }
  return { sha256: sha256Of(absolute), bytes: info.size };
}

// ---------------------------------------------------------------------------
// Code

/**
 * A fingerprint of the installed code roots.
 *
 * Everything under a code root is covered except the declared exclusions, so
 * an edited file, an added dependency and a removed package all move the
 * digest. Per-package digests make a difference nameable instead of only
 * detectable, so a doctor report can say which package moved.
 */
export function codeFingerprint(attemptDir, inventory = []) {
  const entries = [];
  const roots = [];
  for (const root of CODE_ROOTS) {
    const base = join(attemptDir, root);
    if (!existsSync(base)) continue;
    roots.push(root);
    entries.push(...walk(base, root));
  }

  const owned = inventory
    .map((entry) => ({ path: entry.installedRelative, label: `${entry.alias} (${entry.source})` }))
    .filter((entry) => typeof entry.path === "string" && entry.path.length > 0)
    .sort((a, b) => b.path.length - a.path.length);

  const covered = [];
  const excluded = [];
  let excludedCount = 0;

  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (entry.kind === "skipped") {
      excludedCount += 1;
      if (excluded.length < EXCLUSION_LIMIT) {
        excluded.push({ path: entry.path, reason: entry.reason });
      }
      continue;
    }
    const rule = EXCLUSIONS.find((candidate) => candidate.test(parts));
    if (rule) {
      excludedCount += 1;
      if (excluded.length < EXCLUSION_LIMIT) excluded.push({ path: entry.path, reason: rule.name });
      continue;
    }
    covered.push(entry);
  }

  const groups = new Map();
  for (const entry of covered) {
    const group = groupOf(entry.path, owned);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }

  return {
    roots,
    digest: digestOf(covered.map(toComparable)),
    files: covered.filter((entry) => entry.kind === "file").length,
    bytes: covered.reduce((total, entry) => total + (entry.kind === "file" ? entry.bytes : 0), 0),
    packages: Object.fromEntries(
      [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, rows]) => [group, digestOf(rows.sort(byPath).map(toComparable))])
    ),
    excluded,
    excludedCount,
  };
}

/** The comparable form of a walked entry: what the digest actually covers. */
function toComparable(entry) {
  if (entry.kind === "file") return ["file", entry.path, entry.sha256];
  if (entry.kind === "link") return ["link", entry.path, entry.target];
  return ["other", entry.path];
}

function byPath(a, b) {
  return a.path.localeCompare(b.path);
}

/** The installed package, or installer metadata, an entry belongs to. */
function groupOf(path, owned) {
  const root = CODE_ROOTS.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
  const owner = owned.find(
    (entry) => path === entry.path || path.startsWith(`${entry.path}/`)
  );
  if (owner) return `${root}: ${owner.label}`;
  return `${root} (installer metadata)`;
}

/**
 * Every entry under a root, in a stable order.
 *
 * A Git directory is recorded as skipped rather than read: a checkout's object
 * store says nothing about installed code, and reading it would be both slow
 * and pointless. A symlink is recorded by its target and never followed: a
 * link out of the tree is a fact about the installation, not permission to
 * read whatever it points at.
 */
function walk(root, prefix, out = [], depth = 0) {
  if (depth > 64) return out;
  const listing = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of listing) {
    const absolute = join(root, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      out.push({ kind: "link", path, target: linkTarget(absolute) });
      continue;
    }
    if (entry.isDirectory()) {
      const rule = EXCLUSIONS.find((candidate) => candidate.directory?.(path.split("/")));
      if (rule) {
        out.push({ kind: "skipped", path, reason: rule.name });
        continue;
      }
      walk(absolute, path, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      out.push({ kind: "other", path });
      continue;
    }
    out.push({
      kind: "file",
      path,
      sha256: sha256Of(absolute),
      bytes: lstatSync(absolute).size,
    });
  }
  return out;
}

function linkTarget(absolute) {
  try {
    return readlinkSync(absolute);
  } catch {
    // A link that cannot be read is still a fact about the tree; recording that
    // keeps the fingerprint total without pretending to know the target.
    return "(unreadable link)";
  }
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---------------------------------------------------------------------------
// Baseline

/** The runtime, toolchain and platform this measurement was taken on. */
export async function baselineOf(env) {
  return {
    pi: piVersionOf(env),
    node: process.versions.node,
    npm: await npmVersionOf(env),
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * The Pi build the manager is running inside.
 *
 * Read from the CLI's own package rather than asked for over a pipe: the answer
 * must describe the executable that owns installs and launches, and it is
 * needed even where spawning a child is not possible.
 */
function piVersionOf(env) {
  const cli = piCliOf(env);
  if (!cli) return null;
  let dir = dirname(cli);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof parsed.version === "string") return parsed.version;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The Pi executable this manager runs inside, when it can be located.
 *
 * `WARDROBE_PI_CLI` names it explicitly for a caller that did not start the
 * manager the usual way; otherwise it is the executable Pi itself was started
 * from, which is the one that must own installs and launches.
 */
export function piCliOf(env) {
  const cli = env?.WARDROBE_PI_CLI || process.argv[1];
  return cli && existsSync(cli) ? cli : null;
}

async function npmVersionOf(env) {
  try {
    const result = await run("npm", ["--version"], { env, timeoutMs: 20_000 });
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}
