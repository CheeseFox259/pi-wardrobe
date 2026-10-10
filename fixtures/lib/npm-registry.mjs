// Controlled npm registry served over loopback.
//
// Self-authored tarballs are packed with npm itself, then published from a
// hand-built packument carrying real integrity hashes and install-script
// metadata, so `pi install npm:<fixture>@<version>` performs a genuine npm
// resolution and install without publishing anything to a public registry.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, readBytes } from "./fsx.mjs";
import { writeFixturePackage } from "./payloads.mjs";

const DEFAULT_NAME = "wardrobe-fixture";

export class NpmRegistryFixture {
  constructor({ sandbox, server, name, versions, tarballs, markerLog, extensionLog }) {
    this.sandbox = sandbox;
    this.server = server;
    this.name = name;
    this.versions = versions;
    this.tarballs = tarballs;
    this.markerLog = markerLog;
    this.extensionLog = extensionLog;
  }

  static async create({
    sandbox,
    server,
    name = DEFAULT_NAME,
    versions = [
      { version: "1.0.0", exitCode: 0 },
      { version: "2.0.0", exitCode: 17 },
    ],
  }) {
    const markerLog = sandbox.markerLog;
    const extensionLog = sandbox.extensionLog;
    const npm = (args, cwd) =>
      sandbox.runner.run("npm", args, {
        cwd,
        env: sandbox.childEnv(),
      }).then((result) => {
        if (result.code !== 0) {
          throw new Error(`npm ${args.join(" ")} failed (${result.code})\n${result.stderr}`);
        }
        return result.stdout.trim();
      });

    const packDir = join(sandbox.work, "npm-pack");
    ensureDir(packDir);

    const tarballs = new Map();
    for (const spec of versions) {
      const source = join(packDir, `build-${spec.version}`);
      ensureDir(source);
      const { manifest } = writeFixturePackage(source, {
        name,
        version: spec.version,
        markerLog,
        source: "npm",
        exitCode: spec.exitCode,
        extensionLog,
      });
      // --ignore-scripts keeps the pack step itself from running the fixture's
      // deliberately failing postinstall.
      const packed = JSON.parse(
        await npm(
          [
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            packDir,
          ],
          source
        )
      );
      tarballs.set(spec.version, {
        bytes: readBytes(join(packDir, packed[0].filename)),
        manifest,
        exitCode: spec.exitCode,
      });
    }

    const base = `/npm/${name}`;
    server.json(base, () => ({
      type: "application/json",
      body: JSON.stringify(buildPackument({ name, versions, tarballs, server, base })),
    }));
    for (const [version, entry] of tarballs) {
      const path = `${base}/-/${name}-${version}.tgz`;
      server.bytes(path, () => ({ body: entry.bytes }));
    }

    return new NpmRegistryFixture({
      sandbox,
      server,
      name,
      versions,
      tarballs,
      markerLog,
      extensionLog,
    });
  }

  /** Point npm and Pi's nested npm invocations at this loopback registry. */
  configureNpm() {
    const { npmUserConfig } = this.sandbox.npmConfig;
    const registry = `${this.server.origin}/npm/`;
    writeNpmrc(npmUserConfig, registry);
    return registry;
  }

  sourceAt(version) {
    return `npm:${this.name}@${version}`;
  }

  /** Where Pi's native install places this package inside one agent directory. */
  installedPath(agentDirPath) {
    return join(agentDirPath, "npm", "node_modules", this.name);
  }

  installedVersion(agentDirPath) {
    try {
      return JSON.parse(
        readBytes(`${this.installedPath(agentDirPath)}/package.json`).toString("utf8")
      ).version;
    } catch {
      return null;
    }
  }

  entry(version) {
    return this.tarballs.get(version);
  }
}

function writeNpmrc(path, registry) {
  ensureDir(dirname(path));
  writeFileSync(
    path,
    [`registry=${registry}`, "ignore-scripts=false", "audit=false", "fund=false", ""].join("\n")
  );
}

function buildPackument({ name, versions, tarballs, server, base }) {
  const packed = {};
  for (const spec of versions) {
    const entry = tarballs.get(spec.version);
    packed[spec.version] = {
      name: entry.manifest.name,
      version: entry.manifest.version,
      type: "module",
      hasInstallScript: true,
      scripts: entry.manifest.scripts,
      pi: entry.manifest.pi,
      dist: {
        tarball: `${server.origin}${base}/-/${name}-${spec.version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(entry.bytes).digest("base64")}`,
        shasum: createHash("sha1").update(entry.bytes).digest("hex"),
      },
    };
  }
  const latest = versions[versions.length - 1].version;
  return {
    _id: name,
    name,
    "dist-tags": { latest },
    versions: packed,
  };
}
