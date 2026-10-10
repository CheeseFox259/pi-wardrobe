// Shared builders for preset declarations used by the manager checks.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A valid Minimal Coding declaration: the shape ticket 02 must accept. */
export function minimalCoding(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "minimal-coding",
    name: "Minimal Coding",
    version: "1.0.0",
    description: "Native Pi only, no external packages.",
    compatibility: { pi: ">=1.1.0 <2.0.0" },
    ...overrides,
  };
}

/**
 * A declaration that references an external package.
 *
 * Resource selectors name package-relative paths: they are not resolved on
 * disk until the package is installed.
 */
export function composedPreset(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "composed",
    name: "Composed",
    version: "2.1.0",
    compatibility: { pi: "^1.1.0" },
    packages: { "@scope/tools": { source: "npm:@scope/tools@1.2.3" } },
    resources: [
      {
        package: "@scope/tools",
        kind: "skills",
        include: ["skills/review/SKILL.md"],
      },
    ],
    runtime: { thinking: "high", tools: { enable: ["bash"] } },
    persona: { append: ["Prefer small diffs."] },
    ...overrides,
  };
}

/** Write a preset directory containing its declaration. */
export function writePreset(root, name, definition) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "preset.json"), `${JSON.stringify(definition, null, 2)}\n`);
  return dir;
}
