// Self-authored fixture package payloads.
//
// Every file below is generated into the harness temporary root. The only code
// the fixture ever installs or executes is defined here, and each script writes
// markers into a fixture-owned log path.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "./fsx.mjs";

/**
 * An extension that registers an observable tool and command and reports its
 * own lifecycle events. It performs no I/O outside the fixture-owned event log.
 */
export function extensionSource({ eventsLog }) {
  const log = JSON.stringify(eventsLog);
  return `import { appendFileSync } from "node:fs";

const LOG = ${log};
const note = (event, extra = {}) =>
  appendFileSync(LOG, JSON.stringify({ source: "extension", event, ...extra }) + "\\n");

export default function (pi) {
  globalThis.__wardrobeFixtureLoads = (globalThis.__wardrobeFixtureLoads ?? 0) + 1;
  note("load", { loads: globalThis.__wardrobeFixtureLoads });

  pi.registerTool({
    name: "fixture_probe",
    label: "Fixture probe",
    description: "Controlled no-op tool used to observe registration",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "fixture" }] }),
  });

  pi.registerCommand("fixture-only", { handler: async () => {} });

  pi.on("session_start", (event) => note("session_start", { reason: event.reason }));
  pi.on("session_shutdown", (event) => note("session_shutdown", { reason: event.reason }));
}
`;
}

/**
 * A dependency install script that records the revision it ran for. `exitCode`
 * models a dependency script that fails after its marker is already written.
 */
export function postinstallSource({ markerLog, source, exitCode = 0 }) {
  return `import { appendFileSync, existsSync, readFileSync } from "node:fs";

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8").trim() : null);
const version = (() => {
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).version ?? null;
  } catch {
    return null;
  }
})();

appendFileSync(
  ${JSON.stringify(markerLog)},
  JSON.stringify({
    source: ${JSON.stringify(source)},
    version,
    revision: read("revision.txt"),
    cwd: process.cwd(),
  }) + "\\n"
);

${exitCode ? `process.exit(${exitCode});` : ""}
`;
}

/** Write a fixture package directory and return its path. */
export function writeFixturePackage(
  dir,
  { name, version, markerLog, source, exitCode, extensionLog, extraFiles }
) {
  const manifest = {
    name,
    version,
    type: "module",
    private: true,
    scripts: { postinstall: "node postinstall.mjs" },
    pi: { extensions: ["extension.mjs"] },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, "postinstall.mjs"),
    postinstallSource({ markerLog, source, exitCode })
  );
  writeFileSync(join(dir, "extension.mjs"), extensionSource({ eventsLog: extensionLog }));
  for (const [file, contents] of Object.entries(extraFiles ?? {})) {
    const target = join(dir, file);
    ensureDir(dirname(target));
    writeFileSync(target, contents);
  }
  return { dir, manifest };
}
