// Text rendering for /wardrobe results.
//
// Kept separate from the command logic so the machine-readable result and the
// human-readable text are derived from the same object.

import { STATES } from "./doctor.mjs";
import { identityKey } from "./identity.mjs";

/** Render a successful command result. Failures carry their own `text`. */
export function renderResult(result) {
  switch (result.command) {
    case "list":
      return renderList(result);
    case "show":
      return renderShow(result);
    case "explain":
      return renderExplain(result);
    case "install":
      return renderPlan(result);
    case "status":
      return renderStatus(result);
    case "doctor":
      return renderDoctor(result);
    case "use":
      return result.kind === "soft" ? renderSoftUse(result) : renderUse(result);
    case "bind":
      return renderBind(result);
    case "remove":
      return renderRemove(result);
    case "release":
      return renderRelease(result);
    case "retain":
      return renderRetain(result);
    default:
      return `${result.command}: done`;
  }
}

function renderList(result) {
  const lines = ["Wardrobe presets (discovered), and the revisions installed here:"];
  if (result.presets.length === 0) lines.push("  (none found)");
  for (const preset of result.presets) {
    const captured = preset.snapshot ? `snapshot ${preset.snapshot.capturedAt}` : "no snapshot";
    lines.push(
      `  ${identityKey(preset)}  ${preset.name} ${preset.version}  [${preset.state}, ${captured}]`
    );
  }
  for (const rejection of result.rejected) {
    lines.push(`  rejected: ${rejection.text}`);
  }
  lines.push(...revisionLines(result.revisions));
  for (const entry of result.unreadable ?? []) {
    lines.push(`  unreadable revision record: ${entry.file} — ${entry.reason}`);
  }
  lines.push(`  installed in your own environment: ${result.installed}  active: ${result.active}`);
  return lines.join("\n");
}

/**
 * Installed revisions, one line each.
 *
 * The recorded state and the observed state are both printed. They are usually
 * the same, and when they are not, that difference is the whole answer.
 */
function revisionLines(revisions, { indent = "  " } = {}) {
  if (!revisions) return [];
  if (revisions.length === 0) return [`${indent}installed revisions: (none)`];
  const lines = [`${indent}installed revisions:`];
  for (const revision of revisions) {
    const preset = `${revision.preset.name ?? "?"} ${revision.preset.version ?? ""}`.trim();
    const recorded = revision.recorded === revision.state ? "" : ` (recorded ${revision.recorded})`;
    lines.push(
      `${indent}  ${revision.revision}  ${preset}  ${revision.state}${recorded}` +
        (revision.lock ? `  lock ${revision.lock.slice(0, 16)}` : "  no lock") +
        (revision.drift ? `  drift ${revision.drift}` : "") +
        (revision.unverified ? `  unverified ${revision.unverified}` : "")
    );
  }
  return lines;
}

function renderShow(result) {
  const { preset, definition } = result;
  const lines = [
    `${definition.name} (${identityKey(preset)})`,
    `  version: ${definition.version}`,
    `  source: ${preset.source}`,
    `  captured from: ${preset.capturedFrom}`,
  ];
  if (definition.description) lines.push(`  description: ${definition.description}`);
  lines.push(`  compatibility.pi: ${definition.compatibility?.pi ?? "(none declared)"}`);
  lines.push(
    `  declared packages: ${result.packages.map((entry) => entry.alias).join(", ") || "(none)"}`
  );
  lines.push(
    `  selected resources: ${result.resources.flatMap((selector) => selector.loaded).join(", ") || "(none)"}`
  );
  lines.push(...renderLayers(result.layers));
  lines.push(`  state: ${preset.state}  installed: ${result.installed}  active: ${result.active}`);
  if (result.revisions) lines.push(...revisionLines(result.revisions));
  return lines.join("\n");
}

/**
 * Layers, oldest first: what this environment is actually made of.
 *
 * A layer revision appears under `revision` for composed views and under
 * `source` for a sealed plan; both name the same thing.
 */
function renderLayers(layers) {
  if (!layers || layers.length === 0) return [];
  const lines = ["  composed from (base first):"];
  return lines.concat(
    layers.map((layer, index) => {
      const revision = layer.revision ?? layer.source?.commit ?? layer.source?.version ?? null;
      return (
        `    ${index === layers.length - 1 ? "->" : "  "} ${layer.kind}: ${layer.identity}` +
        (revision ? ` @ ${revision}` : "")
      );
    })
  );
}

function renderPlan(result) {
  const plan = result.plan;
  const state = result.staging ? `${result.state} (staged, resources inactive)` : result.state;
  const lines = [
    `Review plan ${plan.planId} for ${plan.declaration.name} ${plan.declaration.version}`,
    `  state: ${state}  installed: ${result.installed ?? false}  active: ${result.active}`,
    `  source: ${plan.source.kind} ${plan.source.locator} (declaration ${plan.source.declarationPath})`,
  ];
  if (plan.source.commit) lines.push(`  commit: ${plan.source.commit}`);
  if (plan.source.integrity) lines.push(`  integrity: ${plan.source.integrity}`);
  lines.push(...renderLayers(plan.layers));
  lines.push("  would install:");
  for (const surface of plan.installationSurfaces) {
    lines.push(
      `    ${surface.alias}: ${surface.source} -> ${surface.artifact?.tarball ?? surface.resolvesTo ?? surface.artifact?.url ?? "?"}${surface.installsCode ? "  (runs install script)" : ""}` +
        (surface.declaredBy ? `  [from ${surface.declaredBy.layer}]` : "")
    );
  }
  for (const surface of plan.installationSurfaces) {
    if (surface.resourceRoot) lines.push(`    package root: ${surface.alias}/${surface.resourceRoot}`);
  }
  if (plan.agent) {
    lines.push("  agent files (created on first launch):");
    for (const file of plan.agent.files) lines.push(`    ${file.target} <- ${file.package}/${file.source}${file.mutable ? " (mutable seed; existing file preserved)" : " (locked)"}`);
    for (const directory of plan.agent.directories ?? []) lines.push(`    directory: ${directory} (0700)`);
    lines.push(`  agent settings: ${JSON.stringify(plan.agent.settings)}`);
  }
  lines.push("  would load:");
  if (plan.loadSurfaces.length === 0) {
    lines.push("    (nothing: no effective selector selects a resource)");
  }
  for (const surface of plan.loadSurfaces) lines.push(`    ${surface.surface}  (from ${surface.from})`);
  for (const selector of plan.resourceSelectors) {
    for (const excluded of selector.excluded ?? []) {
      lines.push(
        `    not loaded: ${selector.package}:${selector.kind}/${excluded.path} — ${excluded.reason} (${excluded.identity})`
      );
    }
  }
  lines.push(...renderPreferences(plan));
  if (result.staging) lines.push(...renderStaging(result.staging));
  lines.push(`  digest: ${plan.digest}`);
  if (!result.staging) {
    lines.push(`  approve with: /wardrobe install <source> --confirm ${plan.digest}`);
  }
  return lines.join("\n");
}

/**
 * The intended configuration beside the observed state.
 *
 * Nothing here is a promise that the revision will run: `launchable` is
 * reported as what it always is until a launch is actually verified.
 */
function renderStatus(result) {
  const lines = [`Wardrobe revisions (state: ${result.state})`];
  if (result.session) lines.push(...renderSessionState(result));
  if (result.selected) {
    lines.push(
      `  selected: ${result.selected.revision}  ${result.selected.state}` +
        (result.selected.lock ? `  lock ${result.selected.lock.slice(0, 16)}` : "")
    );
  }
  lines.push(...revisionLines(result.revisions));
  for (const binding of result.bindings ?? []) {
    lines.push(`  binding: ${binding.preset}  ${describeBinding(binding)}`);
  }
  for (const retain of result.retains ?? []) {
    lines.push(`  retained: ${retain.preset} -> ${retain.revision}`);
  }
  lines.push(...renderDesired(result.desired, result.effective));
  for (const entry of result.unreadable ?? []) {
    lines.push(`  unreadable revision record: ${entry.file} — ${entry.reason}`);
  }
  lines.push(
    "  intended: the approved configuration;  observed: what is on disk now;  launchable: false (a launch is a separate, verified step)"
  );
  return lines.join("\n");
}

/**
 * What this session is using, beside what it last recorded wanting.
 *
 * Printed whenever a session is there to ask, because the declared shape of a
 * preset and the state of the process reading it are different facts.
 */
function renderSessionState(result) {
  const state = result.session ?? {};
  const effective = result.effective ?? {};
  const lines = ["  this session:"];
  if (result.pid !== undefined && result.pid !== null) {
    lines.push(`    pid: ${result.pid}`);
  }
  lines.push(`    running revision: ${effective.runningRevision ?? "(none: a personal environment)"}`);
  if (result.codeState?.preset) {
    lines.push(`    running preset: ${result.codeState.preset}`);
  }
  if (result.restrictions && result.restrictions.length > 0) {
    lines.push(`    user restrictions: ${result.restrictions.join(", ")}`);
  }
  lines.push(`    preferences adopted from: ${effective.adoptedFrom ?? "(none)"}`);
  if (state.appliedAt) lines.push(`    last preference change: ${state.appliedAt}`);
  lines.push(`    tools in effect: ${describe(effective.tools)}`);
  lines.push(`    model in effect: ${describe(effective.model)}`);
  lines.push(`    thinking in effect: ${describe(effective.thinking)}`);
  lines.push(`    instructions adopted: ${describe(effective.persona)}`);
  if (result.block) {
    lines.push(`    turn blocked: ${result.block.reason}`);
    if (result.block.relaunchPlan?.command) {
      lines.push(`      relaunch plan: ${result.block.relaunchPlan.command}`);
    }
  }
  return lines;
}

/**
 * A preference change applied inside the running session.
 *
 * Intended and effective are printed together, per field, because the whole
 * point of this command is that "asked for" and "in effect" are different
 * facts — and a field that was asked for and did not take is named as such
 * rather than folded into a tidy "applied".
 */
function renderSoftUse(result) {
  const lines = [
    `Applied in this session: revision ${result.revision}`,
    `  state: ${result.state}  same process, same revision, same packages and resources`,
  ];
  for (const row of result.applied) {
    lines.push(`  ${row.field}: ${row.status}`);
    lines.push(`    intended: ${describe(row.intended)}`);
    lines.push(`    effective: ${describe(row.effective)}`);
    for (const entry of row.notApplied) {
      lines.push(`    not applied: ${describe(entry)}`);
    }
  }
  for (const diagnostic of result.diagnostics ?? []) {
    lines.push(`  diagnostic: ${diagnostic.path}: ${diagnostic.reason}`);
  }
  return lines.join("\n");
}

function describe(value) {
  if (value === null || value === undefined) return "(none)";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
  return String(value);
}

/**
 * What a preset is bound to.
 *
 * Intent and what is available are printed apart: a binding says what should
 * be true at the next launch, and the resolution says whether it is.
 */
function renderBind(result) {
  if (result.mode === "read") {
    const lines = [`Wardrobe bindings (${result.state})`];
    for (const binding of result.bindings) {
      lines.push(`  ${binding.preset}  ${describeBinding(binding)}`);
      for (const entry of migrationLines(binding.migrations)) lines.push(`    ${entry}`);
    }
    if (result.bindings.length === 0) lines.push("  (none recorded)");
    if (result.latestLaunch) {
      lines.push(
        `  last launch: revision ${result.latestLaunch.revision ?? "(none)"}` +
          (result.latestLaunch.mode ? ` in ${result.latestLaunch.mode} mode` : "") +
          ` at ${result.latestLaunch.startedAt}`
      );
    }
    return lines.join("\n");
  }
  const binding = result.binding;
  const lines = [
    `Bound ${binding.preset}: ${binding.mode}${binding.revision ? ` -> ${binding.revision}` : ""}`,
    `  durable: ${binding.durable}` +
      (binding.durable ? "" : "  (made in a session that persists no conversation of its own)"),
    `  resolves now: ${
      result.resolves.revision
        ? `${result.resolves.revision} (${result.resolves.state})`
        : `unavailable — ${result.resolves.reason}`
    }`,
  ];
  for (const entry of result.restrictions ?? []) lines.push(`  restriction: ${entry}`);
  for (const entry of migrationLines(binding.migrations)) lines.push(`  ${entry}`);
  lines.push(
    "  a binding says what should be true at the next launch; it installs nothing and activates nothing"
  );
  return lines.join("\n");
}

/** What a launch moved between, in one form wherever it is reported. */
function migrationLines(migrations) {
  return (migrations ?? []).map(
    (entry) => `migration: ${entry.at}  ${entry.from ?? "(none)"} -> ${entry.to}  ${entry.reason}`
  );
}

/**
 * What each binding would run, beside what is running now.
 *
 * A mismatch between the two is the whole point of reporting both: a binding
 * that cannot be satisfied, or a session on a revision the binding does not
 * name, must not read as health.
 */
function renderDesired(desired, effective) {
  if (!desired || desired.length === 0) return [];
  const lines = ["  bindings resolve to:"];
  for (const entry of desired) {
    lines.push(
      `    ${entry.preset}  ${entry.mode}` +
        (entry.pinned ? ` pinned to ${entry.pinned}` : "") +
        (entry.available
          ? `  -> ${entry.revision} (${entry.state})`
          : `  -> unavailable: ${entry.reason}`)
    );
    for (const restriction of entry.restrictions ?? []) {
      lines.push(`      restriction: ${restriction}`);
    }
    for (const migration of migrationLines(entry.migrations)) {
      lines.push(`      ${migration}`);
    }
    if (effective?.runningRevision && entry.available && effective.runningRevision !== entry.revision) {
      lines.push(
        `      mismatch: this session is running ${effective.runningRevision}, the binding names ${entry.revision}`
      );
    }
  }
  return lines;
}

function describeBinding(binding) {
  if (binding.unreadable) return `unreadable (${binding.unreadable})`;
  const pinned = binding.revision ? ` pinned to ${binding.revision}` : "";
  const last = binding.lastLaunched ? ` last launched ${binding.lastLaunched}` : " never launched";
  return `${binding.mode}${pinned}${last}`;
}

/**
 * The launch plan.
 *
 * What a launch would add, what it would run, and what it explicitly does not
 * do. Nothing here is a promise that the launch will succeed beyond the state
 * the doctor just measured.
 */
function renderUse(result) {
  const plan = result.launchPlan;
  const lines = [
    `Launch plan for ${plan.preset.name ?? "?"} ${plan.preset.version ?? ""} (revision ${plan.revision})`,
    `  state: ${plan.state}  lock: ${plan.lock ? plan.lock.slice(0, 16) : "none"}`,
    `  this is a plan: nothing was started, and nothing runs inside this session`,
    `  agent dir: ${plan.agentDir}`,
    `  session dir: ${plan.sessionDir.path}${plan.sessionDir.explicit ? " (chosen explicitly)" : " (revision-owned)"}`,
  ];
  lines.push("  would load:");
  if (plan.differences.resources.length === 0) lines.push("    (nothing: no effective selector selects a resource)");
  for (const entry of plan.differences.resources) lines.push(`    ${entry}`);
  if (plan.differences.tools.length > 0) {
    lines.push("  would set tool selection:");
    for (const entry of plan.differences.tools) lines.push(`    ${entry}`);
  }
  lines.push("  would install nothing and would run:");
  for (const entry of plan.differences.packages) {
    lines.push(`    ${entry.alias}: ${entry.source}${entry.installsCode ? "  (runs install-time code)" : ""}`);
  }
  if (plan.differences.packages.length === 0) lines.push("    (no packages)");
  lines.push(
    `  code: ${plan.differences.code.files} locked file(s) under ${plan.differences.code.roots.join(", ") || "(no roots)"}` +
      `${plan.differences.code.packages.length ? ` — ${plan.differences.code.packages.length} package root(s)` : ""}`
  );
  for (const diagnostic of result.diagnostics ?? []) {
    lines.push(`  diagnostic: ${diagnostic.reason}`);
  }
  lines.push(`  launch with: ${plan.command}`);
  lines.push("  this does not:");
  for (const entry of plan.doesNot) lines.push(`    - ${entry}`);
  return lines.join("\n");
}

/** The full diagnosis, component by component. */
function renderDoctor(result) {
  const lines = [`Wardrobe doctor (state: ${result.state})`];
  for (const binding of result.bindings ?? []) {
    lines.push(`  binding ${binding.preset}: ${describeBinding(binding)}`);
  }
  for (const retain of result.retains ?? []) {
    lines.push(`  retained ${retain.preset}: ${retain.revision}`);
  }
  lines.push(...renderDesired(result.desired, null));
  for (const revision of result.revisions) lines.push(...renderDiagnosis(revision));
  for (const entry of result.unreadable ?? []) {
    lines.push(`  unreadable revision record: ${entry.file} — ${entry.reason}`);
  }
  if (result.revisions.length === 0) lines.push("  (no revisions are installed here)");
  return lines.join("\n");
}

function renderDiagnosis(revision) {
  const lines = [
    `  revision ${revision.revision}  ${revision.preset.name ?? "?"} ${revision.preset.version ?? ""}`,
    `    state: ${revision.state} — ${revision.detail ?? STATES[revision.state] ?? ""}`,
  ];
  if (revision.recorded !== revision.state) {
    lines.push(`    recorded by the install as: ${revision.recorded}`);
  }
  if (revision.lock) {
    const baseline = revision.lock.baseline ?? {};
    lines.push(`    lock ${revision.lock.digest.slice(0, 16)} (schema ${revision.lock.schemaVersion})`);
    lines.push(`      configuration ${revision.lock.configuration.digest.slice(0, 16)}`);
    lines.push(
      `      code ${short(revision.lock.code.digest)}  ${revision.lock.code.files} file(s), ${revision.lock.code.bytes} byte(s)` +
        `  ${revision.lock.code.excludedCount} excluded`
    );
    for (const [group, digest] of Object.entries(revision.lock.code.packages ?? {})) {
      lines.push(`        ${group} ${short(digest)}`);
    }
    lines.push(
      `      baseline pi ${baseline.pi ?? "unknown"}  node ${baseline.node ?? "unknown"}  npm ${baseline.npm ?? "unknown"}  ${baseline.platform ?? "?"}/${baseline.arch ?? "?"}`
    );
    for (const resource of revision.lock.resources) {
      lines.push(`      resource ${resource.package}/${resource.kind}/${resource.path}  ${resource.sha256.slice(0, 16)}`);
    }
  } else {
    lines.push("    lock: none recorded, so this revision cannot be verified");
  }
  for (const entry of revision.drift ?? []) {
    lines.push(`    drift [${entry.component}] ${entry.path}: ${entry.detail}`);
  }
  for (const entry of revision.unverified ?? []) {
    lines.push(`    unverified [${entry.component}]: ${entry.reason}`);
  }
  if (revision.runtimeData?.length) {
    lines.push(`    runtime data (not locked code): ${revision.runtimeData.join(", ")}`);
  }
  if (revision.failure) {
    lines.push(`    retained failure: ${revision.failure.message}`);
    lines.push(`      residual files kept: ${(revision.residual ?? []).length} (nothing was rolled back)`);
  }
  lines.push(`    launchable: ${revision.launchable}`);
  return lines;
}

function short(digest) {
  return digest ? digest.slice(0, 16) : "(none)";
}

/**
 * What staging holds.
 *
 * The inventory is deliberately separate from launch availability: a staged
 * revision has its resources filtered out, and starting a process against it is
 * a later, explicit step.
 */
function renderStaging(staging) {
  const lines = [`  staged revision ${staging.revision} (${staging.state}), attempt ${staging.attempt}`];
  if (staging.alreadyAvailable) {
    lines.push("    this revision was already staged and still matches its lock; nothing was reinstalled in place");
  }
  if (staging.superseded) {
    lines.push(
      `    attempt ${staging.superseded.attempt} was replaced, not reused: it measured ${staging.superseded.state}` +
        ` (${staging.superseded.drift} drift, ${staging.superseded.unverified} unverified)`
    );
  }
  lines.push(`    agent dir: ${staging.agentDir}`);
  for (const entry of staging.installed) {
    lines.push(
      `    ${entry.alias}: ${entry.source}${entry.identity?.version ? ` @ ${entry.identity.version}` : entry.identity?.commit ? ` @ ${entry.identity.commit}` : ""}${entry.filtered ? "  (resources filtered inactive)" : "  (NOT filtered)"}`
    );
  }
  lines.push(`    resources active: ${staging.resourcesActive}`);
  if (staging.lockDigest) {
    lines.push(`    lock: ${staging.lockDigest.slice(0, 16)} (measured from the installed tree)`);
  }
  if (staging.previousAttemptsRetained.length > 0) {
    lines.push(
      `    earlier attempts retained: ${staging.previousAttemptsRetained.join(", ")} — their files are still on disk and were not rolled back`
    );
  }
  if (staging.residual.length > 0) {
    lines.push(`    residual files in this attempt: ${staging.residual.length}`);
    for (const file of staging.residual.slice(0, 10)) lines.push(`      ${file}`);
    if (staging.residual.length > 10) lines.push(`      … ${staging.residual.length - 10} more`);
  }
  lines.push("    launch availability is not verified here; nothing is active");
  return lines;
}

/** Effective preferences, always marked as proposals until a preset is used. */
function renderPreferences(plan) {
  if (!plan.runtime) return [];
  const { tools, thinking } = plan.runtime;
  const lines = ["  preferences (proposals, not applied):"];
  if (thinking) lines.push(`    thinking: ${thinking.value} (from ${thinking.layer})`);
  if (tools.enabled.length > 0) {
    lines.push(`    enable: ${tools.enabled.map((entry) => entry.tool).join(", ")}`);
  }
  for (const entry of tools.disabled) {
    lines.push(`    disable: ${entry.tool} — ${entry.reason}`);
  }
  for (const entry of tools.unmet) {
    lines.push(`    unmet: ${entry.tool} — ${entry.reason}`);
  }
  if (plan.persona?.append?.length > 0) {
    lines.push(`    persona append (in layer order): ${plan.persona.append.length} instruction(s)`);
  }
  return lines;
}

function renderExplain(result) {
  const lines = [
    `${result.definition.name} (${identityKey(result.preset)}) — composed environment:`,
  ];
  lines.push(...renderLayers(result.layers));
  // Containers exist in the structured result so nested leaves keep their
  // provenance; the text shows the leaves.
  for (const entry of result.fields.filter((field) => !field.container)) {
    lines.push(`  ${entry.path} = ${JSON.stringify(entry.value)}`);
    lines.push(`    origin: ${entry.origin}`);
    lines.push(
      `    kind: ${entry.kind}${entry.applied === false ? "  (proposal, not applied)" : ""}` +
        (entry.reason ? `\n    reason: ${entry.reason}` : "")
    );
  }
  if (result.proposals.length > 0) {
    lines.push("Preferences are proposals until a preset is applied:");
    for (const proposal of result.proposals) lines.push(`  ${proposal}`);
  }
  if (result.revision && (result.revision.executable.length > 0 || result.revision.soft.length > 0)) {
    lines.push(
      result.revision.requiresNewRevision
        ? "  overlay change: loaded resources changed — review a new preset revision"
        : `  overlay change: soft only (${result.revision.soft.join(", ") || "no change"}); the reviewed revision still applies`
    );
  }
  lines.push(
    `  executable identity: ${result.executable.packages.length} package(s), ${result.executable.resources.length} resource(s)`
  );
  lines.push(
    `  state: ${result.preset.state}  installed: ${result.installed}  active: ${result.active}`
  );
  return lines.join("\n");
}

function renderRemove(result) {
  const lines = [
    `Removed owned revisions for ${result.preset}:`,
    ...result.removed.map((rev) => `  - ${rev}`),
    "  script external effects: not claimed reversed",
  ];
  if (result.transcriptsDestroyed) {
    lines.push(`  session transcripts destroyed: ${result.transcriptsDestroyed.count}`);
    for (const path of result.transcriptsDestroyed.paths) {
      lines.push(`    - ${path}`);
    }
  }
  return lines.join("\n");
}

function renderRelease(result) {
  const lines = [
    `Released explicit retention for ${result.preset} (revision ${result.revision})`,
  ];
  if (result.stillBlockedByStrict) {
    lines.push(
      "  note: strict binding still pins this revision; removal remains blocked until deliberately re-bound"
    );
  }
  return lines.join("\n");
}

function renderRetain(result) {
  if (result.mode === "read") {
    const lines = ["Wardrobe explicitly retained revisions:"];
    if (result.retains.length === 0) lines.push("  (none recorded)");
    for (const r of result.retains) {
      lines.push(`  ${r.preset} -> ${r.revision}`);
    }
    return lines.join("\n");
  }
  return `Retained preset ${result.preset} (revision ${result.revision})`;
}
