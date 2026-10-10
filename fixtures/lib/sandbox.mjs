// Isolated filesystem and environment for the controlled native fixtures.
//
// Everything a fixture writes lives under one temporary root: HOME, agent
// directories, session storage, npm config and cache, Git config and marker
// logs. The child environment is built from a fixed allowlist, so no personal
// credential, proxy or auth-store setting reaches Pi, npm or Git.
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { digestDir, ensureDir, writeJson } from "./fsx.mjs";
import { ProcessRunner } from "./proc.mjs";

/** Preferences written before any install so post-install drift is detectable. */
export const ORIGINAL_PREFERENCES = {
  defaultThinkingLevel: "medium",
  theme: "dark",
  enableInstallTelemetry: false,
  compaction: { enabled: false },
  retry: { enabled: false },
  fixtureUserChoice: "preserve-me",
};

/** Files that must survive every native install and removal byte-for-byte. */
export const SENTINEL_FILES = {
  "unrelated.txt": "unrelated resource, never owned by a fixture package\n",
  "auth.json": { fixtureCredentialPlaceholder: "never-read-by-fixtures" },
};

/** Sentinel file names, for checks that assert none of them changed. */
export const SENTINEL_NAMES = Object.keys(SENTINEL_FILES);

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "TZ",
  "TMPDIR",
  "HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_AUDIT",
  "NPM_CONFIG_FUND",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "NPM_CONFIG_IGNORE_SCRIPTS",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
];

export class Sandbox {
  constructor(root) {
    this.root = root;
    this.home = join(root, "home");
    this.project = join(root, "project");
    this.sessions = join(root, "sessions");
    this.markers = join(root, "markers");
    this.webroot = join(root, "web");
    this.work = join(root, "work");
    this.agents = join(root, "agents");
    this.markerLog = join(this.markers, "install-markers.jsonl");
    this.extensionLog = join(this.markers, "extension-events.jsonl");
    this.runner = new ProcessRunner();
    this.disposed = false;

    for (const dir of [
      this.home,
      this.project,
      this.sessions,
      this.markers,
      this.webroot,
      this.work,
      this.agents,
    ]) {
      ensureDir(dir);
    }

    // Empty config files keep npm and Git from falling back to the caller's
    // real user and system configuration.
    const config = this.npmConfig;
    for (const file of [
      config.npmUserConfig,
      config.npmGlobalConfig,
      config.gitConfig,
    ]) {
      writeFileSync(file, "");
    }
  }

  static async create() {
    const root = await mkdtemp(join(tmpdir(), "wardrobe-fixture-"));
    return new Sandbox(root);
  }

  /** npm and Git config files, created empty so the allowlist env stays honest. */
  #blankConfig() {
    return {
      npmUserConfig: join(this.root, "npmrc"),
      npmGlobalConfig: join(this.root, "global-npmrc"),
      npmCache: join(this.root, "npm-cache"),
      gitConfig: join(this.root, "gitconfig"),
    };
  }

  get npmConfig() {
    return this.#blankConfig();
  }

  /**
   * Credential-free child environment. Extra variables are opt-in per call so a
   * caller cannot accidentally widen the surface for every child.
   */
  childEnv({ agentDir, sessionDir, registry, extra } = {}) {
    const config = this.#blankConfig();
    const base = {};
    for (const key of CHILD_ENV_ALLOWLIST) {
      if (process.env[key] !== undefined) base[key] = process.env[key];
    }
    return {
      ...base,
      HOME: this.home,
      TMPDIR: this.root,
      LANG: base.LANG ?? "en_US.UTF-8",
      PI_CODING_AGENT_DIR: agentDir ?? join(this.agents, "default"),
      PI_CODING_AGENT_SESSION_DIR: sessionDir ?? this.sessions,
      NPM_CONFIG_USERCONFIG: config.npmUserConfig,
      NPM_CONFIG_GLOBALCONFIG: config.npmGlobalConfig,
      NPM_CONFIG_CACHE: config.npmCache,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      // Observed with ignore-scripts=false on npm 11.x; not a claim about every
      // user policy.
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: config.gitConfig,
      GIT_TERMINAL_PROMPT: "0",
      ...(registry ? { WARDROBE_FIXTURE_REGISTRY: registry } : {}),
      ...extra,
    };
  }

  /** Seed an agent directory with original preferences and unrelated sentinels. */
  seedAgent(name, { settings } = {}) {
    const path = join(this.agents, name);
    ensureDir(path);
    writeJson(join(path, "settings.json"), {
      ...ORIGINAL_PREFERENCES,
      packages: [],
      ...settings,
    });
    for (const [file, content] of Object.entries(SENTINEL_FILES)) {
      const path_ = join(path, file);
      if (typeof content === "string") writeFileSync(path_, content);
      else writeJson(path_, content);
    }
    return path;
  }

  agentPath(name) {
    return join(this.agents, name);
  }

  /** Digest of an agent directory's top-level files, for before/after comparison. */
  snapshotAgent(name) {
    return digestDir(this.agentPath(name));
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.runner.killAll();
    rmSync(this.root, { recursive: true, force: true });
  }
}
