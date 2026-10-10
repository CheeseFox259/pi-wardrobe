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
  lines.push(`  declared packages: ${Object.keys(definition.packages ?? {}).join(", ") || "(none)"}`);
  lines.push(
    `  declared resources: ${(definition.resources ?? []).map((r) => r.package).join(", ") || "(none)"}`
  );
  lines.push(`  state: ${preset.state}  installed: ${result.installed}  active: ${result.active}`);
  return lines.join("\n");
}

function renderExplain(result) {
  const lines = [
    `${result.definition.name} (${identityKey(result.preset)}) — declared fields:`,
  ];
  // Containers exist in the structured result so nested leaves keep their
  // provenance; the text shows the leaves.
  for (const field of result.fields.filter((entry) => !entry.container)) {
    lines.push(`  ${field.path} = ${JSON.stringify(field.value)}`);
    lines.push(`    origin: ${field.origin}`);
    lines.push(
      `    kind: ${field.kind}${field.applied === false ? "  (proposal, not applied)" : ""}`
    );
  }
  if (result.proposals.length > 0) {
    lines.push("Preferences are proposals until a preset is applied:");
    for (const proposal of result.proposals) lines.push(`  ${proposal}`);
  }
  lines.push(
    `  state: ${result.preset.state}  installed: ${result.installed}  active: ${result.active}`
  );
  return lines.join("\n");
}
