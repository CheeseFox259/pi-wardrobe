// Evidence recorder for the controlled native fixtures.
//
// Records are written outside the temporary root (they are the durable output
// of a run) but every temporary path is sanitized before it is written, so the
// report never leaks a machine-specific path.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_EVIDENCE_DIR = ".scratch/wardrobe-v1/evidence";

/**
 * Claims this evidence deliberately does not make. Kept next to the recorder so
 * every generated report carries the same limits.
 */
export const NOT_CLAIMED = [
  "Loopback transport does not validate live GitHub or any public source",
  "No package was published to npm or pushed to a Git remote",
  "Native install is not an arbitrary-code sandbox",
  "Failed installation is not rolled back; residual files and script effects remain",
  "Detached descendants of fixture scripts are not guaranteed to be reclaimed",
  "Only the recorded Node/npm/Pi versions on the recorded platform were exercised",
  "This evidence covers fixture transport only, not the Wardrobe product",
];

export class EvidenceRecorder {
  constructor({ label, runtime, outDir, root }) {
    this.label = label;
    this.runtime = runtime;
    this.outDir = outDir;
    this.root = root;
    this.records = [];
    this.failures = 0;
  }

  /** Record one observation. A thrown assertion is recorded, never swallowed. */
  record(name, details = {}) {
    this.records.push({ name, details });
    return details;
  }

  recordFailure(name, error) {
    this.failures += 1;
    this.records.push({
      name,
      details: { outcome: "failed", error: error instanceof Error ? error.stack : String(error) },
    });
  }

  #sanitize(value) {
    // Ancestors on the current path only: a value referenced twice is not a
    // cycle, so the marker must mean "this is its own ancestor".
    const walk = (node, ancestors) => {
      if (typeof node === "string") return node.split(this.root).join("$FIXTURE_ROOT");
      if (Array.isArray(node)) {
        if (ancestors.has(node)) return "[circular]";
        ancestors.add(node);
        const result = node.map((entry) => walk(entry, ancestors));
        ancestors.delete(node);
        return result;
      }
      if (node && typeof node === "object") {
        if (ancestors.has(node)) return "[circular]";
        ancestors.add(node);
        const result = Object.fromEntries(
          Object.entries(node).map(([key, entry]) => [key, walk(entry, ancestors)])
        );
        ancestors.delete(node);
        return result;
      }
      return node;
    };
    return walk(value, new WeakSet());
  }

  #paths() {
    return {
      json: join(this.outDir, `${this.label}.json`),
      markdown: join(this.outDir, `${this.label}.md`),
    };
  }

  payload() {
    return this.#sanitize({
      label: this.label,
      generatedAt: new Date().toISOString(),
      runtime: this.runtime,
      failures: this.failures,
      records: this.records,
      notClaimed: NOT_CLAIMED,
    });
  }

  /** Synchronous by design: it must still work from an `exit` handler. */
  write() {
    const paths = this.#paths();
    const data = this.payload();
    for (const path of [paths.json, paths.markdown]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(paths.json, `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(paths.markdown, renderMarkdown(data));
    return paths;
  }
}

function renderMarkdown(data) {
  const lines = [
    `# Native fixture evidence: ${data.label}`,
    "",
    `- Generated: ${data.generatedAt}`,
    `- Pi: ${data.runtime.pi}`,
    `- Node: ${data.runtime.node}`,
    `- npm: ${data.runtime.npm}`,
    `- Platform: ${data.runtime.platform} ${data.runtime.arch}`,
    `- Runtime root: ${data.runtime.piRuntimeRoot}`,
    `- Failures: ${data.failures}`,
    "",
    "## Observations",
    "",
  ];
  for (const record of data.records) {
    lines.push(`### ${record.name}`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(record.details, null, 2));
    lines.push("```");
    lines.push("");
  }
  lines.push("## Not claimed by this evidence", "");
  for (const item of data.notClaimed) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n");
}
