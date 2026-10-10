// Text rendering for /wardrobe results.
//
// Kept separate from the command logic so the machine-readable result and the
// human-readable text are derived from the same object.

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
    default:
      return `${result.command}: done`;
  }
}

function renderList(result) {
  const lines = ["Wardrobe presets (discovered, none installed, none active):"];
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
  lines.push(`  installed: ${result.installed}  active: ${result.active}`);
  return lines.join("\n");
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
 * What staging holds.
 *
 * The inventory is deliberately separate from launch availability: a staged
 * revision has its resources filtered out, and starting a process against it is
 * a later, explicit step.
 */
function renderStaging(staging) {
  const lines = [`  staged revision ${staging.revision} (${staging.state}), attempt ${staging.attempt}`];
  if (staging.alreadyAvailable) {
    lines.push("    this revision was already staged; nothing was reinstalled in place");
  }
  lines.push(`    agent dir: ${staging.agentDir}`);
  for (const entry of staging.installed) {
    lines.push(
      `    ${entry.alias}: ${entry.source}${entry.identity?.version ? ` @ ${entry.identity.version}` : entry.identity?.commit ? ` @ ${entry.identity.commit}` : ""}${entry.filtered ? "  (resources filtered inactive)" : "  (NOT filtered)"}`
    );
  }
  lines.push(`    resources active: ${staging.resourcesActive}`);
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
  const { tools, thinking, model } = plan.runtime;
  const lines = ["  preferences (proposals, not applied):"];
  if (thinking) lines.push(`    thinking: ${thinking.value} (from ${thinking.layer})`);
  if (model?.value) {
    lines.push(
      `    model: ${model.value} (${model.winner === "user" ? "an explicit user or CLI choice wins" : `from ${model.layer}`})`
    );
  }
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
