// Installing an approved plan into owned staging.
//
// Nothing here decides what to install: the plan that the user approved does.
// This module re-checks that the plan still hashes to the digest it was
// approved against, re-verifies every artifact the plan named, installs through
// Pi's own package manager into a fresh staging directory, and records exactly
// what is there.
//
// It never activates anything. A staged revision's resources stay filtered out
// of its settings, so nothing loads until a later ticket explicitly activates
// it, and a failed attempt stays visible as failed rather than being rolled
// back — Pi's install runs package scripts, and this manager does not pretend
// otherwise.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { parseSource } from "./identity.mjs";
import { dispatchPiCommand, git, run } from "./proc.mjs";
import { digestMatches } from "./plan.mjs";
import { diagnoseRevision } from "./doctor.mjs";
import { measureRevision, piCliOf } from "./lock.mjs";
import { resolveNpmPackage } from "./npm-source.mjs";
import { StagingStore, inactiveSettings, residualOf } from "./staging.mjs";

/**
 * Install one approved plan.
 *
 * @param {{plan: object, agentDir: string, env: object, registry?: string,
 *   fetchImpl?: Function}} input
 * @returns {Promise<{state: string, record: object, attempt: object|null,
 *   alreadyAvailable: boolean}>}
 */
export async function installApprovedPlan({ plan, agentDir, env, registry, fetchImpl }) {
  assertApprovedPlan(plan);
  await verifyArtifacts(plan, { registry, fetchImpl });

  const store = new StagingStore(agentDir);
  const existing = store.read(plan.planId);
  const previous = existing?.attempts?.at(-1) ?? null;
  let superseded = null;
  // An available revision is never reinstalled into place: its directory is
  // what other work may already refer to. But it is checked, not believed: a
  // record's directory can be gone, or can have drifted since the install, and
  // in both cases it is no longer the revision the approval was given for.
  // Only a revision that still measures as the approved one is handed back.
  if (
    existing?.state === "available" &&
    existing.digest === plan.digest &&
    previous?.agentDir &&
    existsSync(previous.agentDir)
  ) {
    const verified = await diagnoseRevision(existing, { env, plan });
    if (verified.state === "available") {
      return { state: "available", record: existing, attempt: null, alreadyAvailable: true };
    }
    superseded = {
      attempt: previous.attempt,
      state: verified.state,
      drift: verified.drift.length,
      unverified: verified.unverified.length,
    };
  }

  const surfaces = plan.installationSurfaces.map((surface) => ({
    alias: surface.alias,
    // Resolved before anything is written: an unresolvable source must not
    // leave a staging directory behind.
    source: installSourceOf(surface),
  }));
  const attempt = store.nextAttempt(existing);
  const attemptDir = store.attemptDir(plan.planId, attempt);
  // The declaration is written before anything installs, so no process can
  // observe an unfiltered entry even for the moment between install and the
  // assertion that follows it.
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(
    join(attemptDir, "settings.json"),
    `${JSON.stringify(inactiveSettings(surfaces), null, 2)}\n`
  );

  const startedAt = new Date().toISOString();
  const runs = [];
  let failure = null;

  for (const surface of surfaces) {
    const result = await runPiInstall(surface.source, { attemptDir, env });
    runs.push({ alias: surface.alias, source: surface.source, exitCode: result.code, stderr: tail(result.stderr) });
    if (result.code !== 0) {
      failure = {
        alias: surface.alias,
        source: surface.source,
        message: `pi install exited ${result.code}`,
        stderr: tail(result.stderr),
      };
      break;
    }
  }

  const inventory = failure ? null : await inventoryOf(attemptDir, { plan, env });
  const reasserted = failure ? null : assertInactive(attemptDir, surfaces);
  const mismatch = inventory?.mismatch ?? [];
  // The lock is measured from what is on disk, not from what was asked for: a
  // revision is only available when the tree that exists can be described by
  // the same configuration, resources, code and baseline the approval named.
  const measured = inventory ? await measureRevision({ plan, attemptDir, inventory: inventory.packages, env }) : null;
  const problems = measured?.problems ?? [];
  const available = !failure && mismatch.length === 0 && problems.length === 0;

  const record = store.write({
    planId: plan.planId,
    digest: plan.digest,
    identity: plan.identity,
    declaration: plan.declaration,
    source: plan.source,
    createdAt: existing?.createdAt ?? startedAt,
    state: available ? "available" : "failed",
    // A retained failed attempt is reported, never described as undone. Only
    // attempts whose files are still there are called retained.
    previousAttemptsRetained: (existing?.attempts ?? [])
      .filter((entry) => existsSync(entry.agentDir))
      .map((entry) => entry.attempt),
    // Why the previous attempt was not reused, when it was not reused because
    // it no longer holds. `null` when it was reused or when there was none.
    superseded,
    attempts: [
      ...(existing?.attempts ?? []),
      {
        attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
        state: available ? "available" : "failed",
        agentDir: attemptDir,
        // Staging is owned by this manager and starts empty; nothing outside it
        // is read, written or shared.
        ownsAgentDir: true,
        // What Pi was asked to install, and how each invocation ended.
        runs,
        installed: inventory?.packages ?? [],
        resources: {
          // Resources are installed and filtered: present on disk, loaded by
          // nothing. Activation is a later, explicit step.
          active: 0,
          selectedByPlan: plan.resourceSelectors.map((selector) => ({
            package: selector.package,
            kind: selector.kind,
            loaded: selector.loaded,
          })),
          filters: reasserted ?? null,
        },
        mismatch,
        // Measured after installation, from the tree itself. `null` for an
        // attempt that did not install, because there is nothing to describe.
        lock: measured?.lock ?? null,
        failure:
          failure ??
          (mismatch.length
            ? { message: "installed artifact does not match the approved plan" }
            : problems.length
              ? { message: "the installed revision could not be fully measured" }
              : null),
        // Anything an unsuccessful attempt left behind is reported, whether it
        // failed as a process or failed verification.
        residual: available ? [] : residualOf(attemptDir),
        // Pi's install runs package scripts; nothing here undoes their effects.
        rolledBack: false,
      },
    ],
  });

  const latest = record.attempts.at(-1);
  if (latest.state === "failed") {
    throw Object.assign(
      WardrobeError.from(
        "installation failed; staging is retained as failed/unavailable",
        [
          ...(latest.failure?.alias
            ? [
                new WardrobeDiagnostic({
                  path: `/installationSurfaces/${latest.failure.alias}`,
                  reason: `${latest.failure.message} for ${latest.failure.source}`,
                  hint: latest.failure.stderr || null,
                }),
              ]
            : []),
          ...latest.mismatch.map((entry) =>
            new WardrobeDiagnostic({
              path: `/installationSurfaces/${entry.alias}`,
              reason: `installed artifact does not match the approved plan: ${entry.detail}`,
            })
          ),
          ...problems.map((problem) =>
            new WardrobeDiagnostic({
              path: `/lock${problem.path}`,
              reason: `an available revision needs a complete lock: ${problem.reason}`,
            })
          ),
          new WardrobeDiagnostic({
            path: "",
            reason: `attempt ${latest.attempt} left ${latest.residual.length} file(s) in staging`,
          }),
          ...(record.previousAttemptsRetained.length > 0
            ? [
                new WardrobeDiagnostic({
                  path: "",
                  reason: `earlier attempt(s) ${record.previousAttemptsRetained.join(", ")} are retained on disk; this attempt is separate`,
                }),
              ]
            : []),
        ],
        "nothing was rolled back: Pi's install runs package scripts, and their effects remain. review a new plan or retry into a new attempt"
      ),
      { staging: record }
    );
  }

  return { state: "available", record, attempt: latest, alreadyAvailable: false };
}

/** The plan must still be the plan that was shown and approved. */
function assertApprovedPlan(plan) {
  if (!plan?.approved?.digest) {
    throw WardrobeError.from("installing requires an approved plan", [
      new WardrobeDiagnostic({
        path: "/approved",
        reason: "no approval is recorded for this plan",
        hint: "approve the digest /wardrobe install printed before installing anything",
      }),
    ]);
  }
  if (plan.approved.digest !== plan.digest) {
    throw WardrobeError.from("stored plan no longer matches its digest", [
      new WardrobeDiagnostic({ path: "/digest", reason: "the stored plan has been modified" }),
      new WardrobeDiagnostic({
        path: "",
        reason: `approved ${plan.approved.digest.slice(0, 16)}, plan ${plan.digest.slice(0, 16)}`,
      }),
    ]);
  }
  if (!digestMatches(plan)) {
    throw WardrobeError.from("the approved plan no longer hashes to its digest", [
      new WardrobeDiagnostic({
        path: "/digest",
        reason: "plan content changed after the approval was recorded",
      }),
    ]);
  }
}

/**
 * Re-resolve every npm artifact the plan named.
 *
 * A pinned version can still be republished, so the tarball the registry serves
 * now must be the one the plan was approved against. Git sources are pinned to
 * a full commit, which cannot change under them.
 */
async function verifyArtifacts(plan, { registry, fetchImpl }) {
  for (const surface of plan.installationSurfaces) {
    const source = installSourceOf(surface);
    const parsed = parseSource(source, `/installationSurfaces/${surface.alias}/source`);

    if (parsed.kind === "git") {
      // A git source is pinned to a full commit, so nothing can move under it.
      // What is checked here is that the plan agrees with itself: an artifact
      // that disagrees with its own pinned source is not a reviewable plan.
      const declared = surface.artifact?.kind === "git" ? surface.artifact : null;
      if (!declared || declared.commit !== parsed.ref || declared.url !== parsed.url) {
        throw WardrobeError.from("the approved artifact does not match its pinned source", [
          new WardrobeDiagnostic({
            path: `/installationSurfaces/${surface.alias}/artifact`,
            reason: `source pins ${parsed.url}@${parsed.ref}, artifact names ${declared?.commit ?? "nothing"}`,
          }),
          new WardrobeDiagnostic({
            path: "",
            reason: "the plan is not internally consistent; nothing was installed",
          }),
        ]);
      }
      continue;
    }

    if (parsed.kind !== "npm") continue;
    if (!registry) {
      throw WardrobeError.from("npm source needs a registry to be installed", [
        new WardrobeDiagnostic({
          path: `/installationSurfaces/${surface.alias}`,
          reason: "no registry configured",
        }),
      ]);
    }
    const meta = await resolveNpmPackage({
      name: parsed.package,
      version: parsed.version,
      registry,
      fetchImpl,
    });
    if (meta.version !== parsed.version || meta.integrity !== surface.artifact?.integrity) {
      throw WardrobeError.from("the approved artifact no longer matches the registry", [
        new WardrobeDiagnostic({
          path: `/installationSurfaces/${surface.alias}/artifact`,
          reason: `approved ${surface.artifact?.integrity ?? "nothing"}, registry now ${meta.integrity}`,
        }),
        new WardrobeDiagnostic({
          path: "",
          reason: "the source changed since the plan was displayed; nothing was installed",
        }),
      ]);
    }
  }
}

/**
 * The source Pi installs.
 *
 * A self source is the package that ships the declaration, so it installs as
 * that package's pinned native source. A self source with no pinned native
 * source — a local snapshot — is refused rather than installed as a directory,
 * because Pi does not install a local package's dependencies and the plan's
 * artifacts would silently not be what was approved.
 */
function installSourceOf(surface) {
  const source = surface.source === "." ? surface.resolvesTo : surface.source;
  if (typeof source !== "string" || !/^(npm|git):/.test(source)) {
    throw WardrobeError.from("a self source has no pinned native source to install", [
      new WardrobeDiagnostic({
        path: `/installationSurfaces/${surface.alias}/source`,
        reason: "the package that ships this declaration was not captured from npm or git",
        hint: "Pi does not install a local package's dependencies; review the preset from its published source",
      }),
    ]);
  }
  return source;
}

/** Run `pi install` through Pi's own package manager, in the staging directory. */
async function runPiInstall(source, { attemptDir, env }) {
  const cli = piCli(env);
  const [spawnFile, spawnArgs] = dispatchPiCommand(cli, ["install", source]);
  return run(spawnFile, spawnArgs, {
    cwd: attemptDir,
    env: { ...env, PI_CODING_AGENT_DIR: attemptDir },
  });
}

/**
 * The Pi executable this manager is running inside, or a refusal that says
 * what is missing.
 *
 * The lookup itself lives with the lock, because the lock has to identify the
 * same build: a revision verified by one Pi and installed by another is not a
 * verified revision.
 */
function piCli(env) {
  const cli = piCliOf(env);
  if (!cli) {
    throw WardrobeError.from("cannot locate the Pi executable", [
      new WardrobeDiagnostic({
        path: "",
        reason: `no Pi CLI at ${env?.WARDROBE_PI_CLI ?? "(none)"}`,
        hint: "set WARDROBE_PI_CLI, ensure pi is on PATH, or integrate with pi --wardrobe",
      }),
    ]);
  }
  return cli;
}

/**
 * What is installed in a staging directory, checked against the plan.
 *
 * Pi reports its own view, so the inventory does not guess at Pi's directory
 * layout, and every entry is compared with what the user approved.
 */
async function inventoryOf(attemptDir, { plan, env }) {
  const cli = piCli(env);
  const [spawnFile, spawnArgs] = dispatchPiCommand(cli, ["list"]);
  const listed = await run(spawnFile, spawnArgs, {
    cwd: attemptDir,
    env: { ...env, PI_CODING_AGENT_DIR: attemptDir },
  });
  const declared = parseList(listed.stdout);
  const packages = [];
  const mismatch = [];

  for (const surface of plan.installationSurfaces) {
    const source = installSourceOf(surface);
    const entry = declared.find((candidate) => candidate.source === source);
    if (!entry) {
      mismatch.push({ alias: surface.alias, detail: `Pi does not report ${source} as installed` });
      continue;
    }
    const identity = await installedIdentity(entry, surface, { env });
    packages.push({
      alias: surface.alias,
      source,
      installedPath: entry.path,
      // Recorded relative to the attempt directory so a moved or copied
      // revision is measured inside itself, not through a stale absolute path.
      installedRelative: relative(attemptDir, entry.path).split(sep).join("/"),
      filtered: entry.filtered,
      identity,
    });
    if (!entry.filtered) {
      mismatch.push({ alias: surface.alias, detail: "its resources are not filtered inactive" });
    }
    if (identity.mismatch) {
      mismatch.push({ alias: surface.alias, detail: identity.mismatch });
    }
  }
  return { packages, mismatch };
}

/** Read `pi list` output: the source, whether it is filtered, and its path. */
function parseList(stdout) {
  const packages = [];
  const lines = String(stdout ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {2}(\S.*?)( \(filtered\))?$/.exec(lines[index]);
    if (!match) continue;
    const pathLine = /^ {4}(\S.*)$/.exec(lines[index + 1] ?? "");
    packages.push({
      source: match[1].trim(),
      filtered: Boolean(match[2]),
      path: pathLine ? pathLine[1].trim() : null,
    });
  }
  return packages;
}

/** What Pi installed, compared with the approved artifact. */
async function installedIdentity(entry, surface, { env }) {
  const source = installSourceOf(surface);

  if (surface.artifact?.kind === "npm") {
    const version = readInstalledVersion(entry.path);
    return {
      kind: "npm",
      version,
      // The approved version comes from the installed source, not from the
      // declared one: a self source declares "." and resolves to `npm:…@x.y.z`.
      mismatch: identityMismatch({
        approved: parseSource(source).version,
        installed: version,
        missing: "the installed package has no readable manifest",
      }),
    };
  }

  if (surface.artifact?.kind === "git") {
    const head = entry.path
      ? await git(["-C", entry.path, "rev-parse", "HEAD"], { env }).catch(() => null)
      : null;
    return {
      kind: "git",
      commit: head,
      mismatch: identityMismatch({
        approved: surface.artifact.commit,
        installed: head,
        missing: "the installed checkout has no readable commit",
      }),
    };
  }

  return { kind: "unknown" };
}

/**
 * Whether an installed identity matches the approved one.
 *
 * An identity that cannot be read is a mismatch, not a pass: "installed
 * something I could not check" is not the artifact the user approved.
 */
export function identityMismatch({ approved, installed, missing }) {
  if (!approved) return null;
  if (installed === null || installed === undefined) return missing;
  return installed === approved ? null : `installed ${installed}, approved ${approved}`;
}

function readInstalledVersion(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Re-assert the inactive filters after install.
 *
 * Pi preserves an existing filtered declaration, but the staging record may not
 * depend on that remaining true: a revision that would load something on the
 * next process is not what was approved. Every declared package is filtered,
 * including one the installer added on its own — an unexpected declaration is
 * reported rather than left loading.
 */
function assertInactive(attemptDir, surfaces) {
  const path = join(attemptDir, "settings.json");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  const reinstated = [];
  const packages = (settings.packages ?? []).map((entry) => {
    const declaration = typeof entry === "string" ? { source: entry } : entry;
    if (!surfaces.some((surface) => surface.source === declaration.source)) {
      reinstated.push(`${declaration.source} (not part of the approved plan)`);
    }
    for (const kind of ["extensions", "skills", "prompts", "themes"]) {
      if (!Array.isArray(declaration[kind]) || declaration[kind].length > 0) {
        declaration[kind] = [];
        reinstated.push(`${declaration.source}:${kind}`);
      }
    }
    return declaration;
  });
  writeFileSync(path, `${JSON.stringify({ ...settings, packages }, null, 2)}\n`);
  return reinstated;
}

function tail(text, lines = 12) {
  return String(text ?? "")
    .split("\n")
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}
