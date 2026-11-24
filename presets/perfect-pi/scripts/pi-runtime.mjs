import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export function runNpmReadOnly(args, options = {}) {
  const { platform = process.platform, run = execFileSync, ...execOptions } = options;
  // Windows batch shims require cmd.exe. Only fixed metadata arguments are accepted;
  // no package installation or caller-provided shell syntax is allowed here.
  const allowed = [["root", "--global"], ["view", PI_PACKAGE_NAME, "version", "--json"]];
  if (!allowed.some(command => JSON.stringify(command) === JSON.stringify(args))) throw new Error("Unsupported npm metadata query");
  return platform === "win32"
    ? run("cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`], execOptions)
    : run("npm", args, execOptions);
}

/**
 * Order managed release directory names newest first, so a retained older release can never be
 * selected ahead of the release the installer's `current-version` points at.
 */
function compareReleaseNamesDescending(a, b) {
  const parse = (name) => name.split("-")[0].split(".").map(part => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff) return diff;
  }
  // Equal core version (prerelease or duplicated): keep a deterministic order.
  return b.localeCompare(a);
}

function findPiFromPath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!env.PATH) return null;
  const delimiter = platform === "win32" ? ";" : ":";
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const paths = env.PATH.split(delimiter).filter(Boolean);
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, `pi${ext}`);
      try {
        if (existsSync(candidate)) {
          return realpathSync(candidate);
        }
      } catch {}
    }
  }
  return null;
}

/** Gather candidate Node package directories across supported installations. */
export function piRuntimeRoots(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const roots = [];

  // 1. Explicit PI_GLOBAL_NODE_MODULES (supports delimiter-separated paths)
  if (env.PI_GLOBAL_NODE_MODULES) {
    const delimiter = platform === "win32" ? ";" : ":";
    const explicit = env.PI_GLOBAL_NODE_MODULES.split(delimiter).filter(Boolean);
    roots.push(...explicit);
  }

  // Add candidates for an official managed install (`releases-v1` layout). The `current-version`
  // pointer wins; retained older releases follow newest first.
  const addManagedInstallRoots = (installRoot) => {
    if (!installRoot || !existsSync(installRoot)) return;
    const releaseRoots = (release) => [
      join(installRoot, "releases", release, "node_modules"),
      join(installRoot, "releases", release, "node_modules", ...PI_PACKAGE_NAME.split("/")),
    ];
    try {
      const currentVersionFile = join(installRoot, "current-version");
      if (existsSync(currentVersionFile)) {
        const currentVersion = readFileSync(currentVersionFile, "utf8").trim();
        if (currentVersion) roots.push(...releaseRoots(currentVersion));
      }
      const releasesDir = join(installRoot, "releases");
      if (existsSync(releasesDir)) {
        for (const release of readdirSync(releasesDir).sort(compareReleaseNamesDescending)) {
          roots.push(...releaseRoots(release));
        }
      }
      roots.push(join(installRoot, "node_modules"));
    } catch {}
  };

  // 2. Agent directory layouts (checked early for user-installed or managed overrides).
  // `agentDir: null` opts out of host-directory discovery; tests use it for isolation.
  const agentDir = "agentDir" in options
    ? options.agentDir
    : env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const managedInstallRoot = options.managedInstallRoot ?? env.PI_MANAGED_INSTALL_ROOT ?? (agentDir ? join(agentDir, "install") : null);

  if (managedInstallRoot) {
    addManagedInstallRoots(managedInstallRoot);
  }

  if (agentDir) {
    roots.push(
      join(agentDir, "npm", "node_modules"),
      join(agentDir, "node_modules"),
      join(agentDir, "@earendil-works", "pi-coding-agent"),
      agentDir,
    );
  }

  // 4. PATH-resolved Pi binary layout (the managed launcher symlink, or an npm bin shim)
  if (!options.skipPath) {
    try {
      const piBin = findPiFromPath(options);
      if (piBin) {
        const parent = dirname(dirname(piBin));
        addManagedInstallRoots(join(parent, "install"));
        roots.push(
          join(parent, "npm", "node_modules"),
          join(parent, "node_modules"),
          parent,
        );
      }
    } catch {}
  }

  // 5. Windows layouts (prioritized when platform is win32)
  if (platform === "win32" || env.APPDATA || env.LOCALAPPDATA || env.ProgramFiles) {
    if (env.APPDATA) roots.push(join(env.APPDATA, "npm", "node_modules"));
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, "npm", "node_modules"));
    if (env.ProgramFiles) roots.push(join(env.ProgramFiles, "nodejs", "node_modules"));
  }

  // 6. npm global root
  if (options.npmGlobal) {
    roots.push(options.npmGlobal);
  } else if (!options.skipNpm) {
    try {
      const npmRoot = runNpmReadOnly(["root", "--global"], {
        platform,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: options.npmTimeoutMs ?? 3000,
      }).trim();
      if (npmRoot) roots.push(npmRoot);
    } catch {}
  }

  // 7. Node execPath prefix layouts
  const execPath = options.execPath ?? process.execPath;
  if (execPath) {
    const prefix = dirname(dirname(execPath));
    roots.push(
      join(prefix, "lib", "node_modules"),
      join(prefix, "node_modules"),
      join(dirname(execPath), "node_modules"),
    );
  }

  // 8. System lib directories (/usr/lib, /usr/local/lib, Homebrew)
  if (!options.skipSystemRoots && platform !== "win32") {
    roots.push(
      "/opt/homebrew/lib/node_modules",
      "/usr/local/lib/node_modules",
      "/usr/lib/node_modules",
      "/usr/lib",
    );
  }

  // 9. Cwd / local node_modules
  const cwd = options.cwd ?? process.cwd();
  if (cwd) {
    roots.push(join(cwd, "node_modules"));
  }

  return [...new Set(roots.filter(Boolean).map((candidate) => resolve(candidate)))];
}

/**
 * Checks whether a directory is a valid @earendil-works/pi-coding-agent package.
 */
function inspectPackageDir(dir) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name === PI_PACKAGE_NAME || dir.endsWith("pi-coding-agent")) {
      const entryCandidates = [
        join(dir, "dist", "index.js"),
        pkg.main ? join(dir, pkg.main) : null,
        join(dir, "index.js"),
      ].filter(Boolean);
      const entry = entryCandidates.find((e) => existsSync(e)) ?? join(dir, "dist", "index.js");
      return {
        version: pkg.version,
        root: dir,
        packageDir: dir,
        entry,
      };
    }
  } catch {}
  return null;
}

/**
 * Detect installed Pi host runtime across portable layout candidates.
 *
 * @param {object} [options]
 * @returns {Promise<{ version: string, root: string, packageDir: string, entry: string } | null>}
 */
export async function detectPiRuntime(options = {}) {
  const roots = options.roots ?? piRuntimeRoots(options);
  for (const root of roots) {
    // Check candidate as container (e.g. node_modules/@earendil-works/pi-coding-agent)
    const directCandidate = join(root, ...PI_PACKAGE_NAME.split("/"));
    const directHit = inspectPackageDir(directCandidate);
    if (directHit) return directHit;

    // Check candidate as the package directory itself
    const rootHit = inspectPackageDir(root);
    if (rootHit) return rootHit;
  }
  return null;
}

/**
 * Alias for detectPiRuntime.
 */
export const resolvePiRuntime = detectPiRuntime;

/**
 * Convenience helper to get the executable index.js entry path of Pi coding agent.
 */
export async function findPiEntry(options = {}) {
  const runtime = await detectPiRuntime(options);
  return runtime?.entry ?? null;
}

/**
 * Resolve a sibling `@earendil-works` subpackage of the host runtime.
 *
 * Pi 1.1.0's managed install hoists `pi-ai`, `pi-tui` and `pi-agent-core` next to
 * `pi-coding-agent`; older and npm layouts nest them under the package's own `node_modules`.
 * Callers should use this instead of rebuilding both candidate paths.
 *
 * @param {string} pkgName Package name without the scope, e.g. `pi-ai`.
 * @param {string} [subPath] Path inside the package, or `""` for the package directory.
 * @param {object} [options] `runtime` or `entry` of a known host, otherwise detected.
 * @returns {Promise<string|null>} First existing candidate; the nested path when none exist.
 */
export async function resolvePiSubpackage(pkgName, subPath = "dist/index.js", options = {}) {
  // A package entry is `<root>/dist/index.js` unless `package.json:main` moved it.
  const rootFromEntry = (entry) => (existsSync(join(dirname(entry), "package.json")) ? dirname(entry) : dirname(dirname(entry)));
  const runtime = options.runtime ?? (options.entry ? { root: rootFromEntry(options.entry) } : await detectPiRuntime(options));
  if (!runtime?.root) return null;
  const scope = ["@earendil-works", pkgName, subPath];
  const candidates = [
    join(runtime.root, "node_modules", ...scope),
    join(dirname(dirname(runtime.root)), ...scope),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}
