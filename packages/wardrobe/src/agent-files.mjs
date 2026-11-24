import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackagePath } from "./git-source.mjs";
import { WardrobeError } from "./diagnostics.mjs";
import { validateBindings } from './native-bindings.mjs';

const nonemptyString = value => typeof value === "string" && value.trim().length > 0;
const fieldsMatch = (value, fields) => value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, item]) => Object.hasOwn(fields, key) && fields[key](item));
const SETTINGS = {
  theme: nonemptyString,
  tuiMode: value => ["fullscreen", "regular"].includes(value),
  quietStartup: value => typeof value === "boolean" || value === "header",
  enableSkillCommands: value => typeof value === "boolean",
  defaultTools: value => Array.isArray(value) && value.every(nonemptyString),
  compaction: value => fieldsMatch(value, { enabled: item => typeof item === "boolean", reserveTokens: item => Number.isSafeInteger(item) && item >= 0, keepRecentTokens: item => Number.isSafeInteger(item) && item >= 0 }),
};
const jsonValue = value => value === null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value) && value.every(jsonValue) || value && typeof value === 'object' && Object.values(value).every(jsonValue);
for (const key of ['hideThinkingBlock', 'showCacheMissNotices', 'collapseChangelog', 'terminal', 'images', 'fullscreenExitOutput', 'fullscreenScrollbar', 'fullscreenCopyOnSelect', 'fullscreenWheelScrollLines', 'doubleEscapeAction', 'treeFilterMode', 'showHardwareCursor', 'editorPaddingX', 'outputPad', 'autocompleteMaxVisible', 'mermaidRenderingMode', 'warnings', 'steeringMode', 'followUpMode']) SETTINGS[key] = jsonValue;
export function presetPreferences(settings) { return Object.fromEntries(Object.entries(settings).filter(([key, value]) => Object.hasOwn(SETTINGS, key) && SETTINGS[key](value))); }
const TARGET = /^(?:AGENTS\.md|sol-pi\.json|manifest\.json|components\.json|mcp\.json|web-search\.json|pi-statusline\.json|(?:scripts|docs|agents|habits|wardrobe\/preset)\/.+)$/;
const MUTABLE = new Set(["sol-pi.json", "mcp.json", "web-search.json", "pi-statusline.json"]);
const PRIVATE_DIRECTORY = /^mcp-data(?:\/[a-zA-Z0-9_-]+)?$/;
const SECRET = /(?:^|\/)(?:auth\.json|models\.json|\.env(?:\..*)?|\.npmrc|.*\.(?:pem|key|p12|pfx))$/;
export function agentFileContract(){return {schemaVersion:1,fileKeys:['source','target','mutable','template'],targetPattern:TARGET.source,mutableTargets:[...MUTABLE],settings:Object.keys(SETTINGS),paths:'Safe package-relative source and supported agent-relative target; models/auth remain native Pi.'};}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function safeRelative(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").some(part => !part || part === "." || part === "..");
}

/** Package-owned declarations are reviewed data, never hooks. */
export function reviewAgentFiles({ captured, alias, resourceRoot = "" }) {
  const root = join(captured.root, resourceRoot);
  if (!existsSync(join(root, "package.json"))) return null;
  const manifest = resolvePackagePath(root, "package.json", "/wardrobe/agent");
  const wardrobe = JSON.parse(readFileSync(manifest, "utf8")).wardrobe;
  const bindings = validateBindings(wardrobe?.deviceBindings);
  const declaration = wardrobe?.agent;
  if (declaration === undefined) return bindings.length ? { files: [], settings: {}, deviceBindings: bindings } : null;
  if (!declaration || declaration.schemaVersion !== 1 || Object.keys(declaration).some(key => !["schemaVersion", "files", "directories", "settings"].includes(key))) throw WardrobeError.from("invalid wardrobe.agent declaration");
  if (!Array.isArray(declaration.files)) throw WardrobeError.from("wardrobe.agent.files must be an array");
  const settings = declaration.settings ?? {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.entries(settings).some(([key, value]) => !Object.hasOwn(SETTINGS, key) || !SETTINGS[key](value))) throw WardrobeError.from("wardrobe.agent.settings contains unsupported or private fields");
  const directories = declaration.directories ?? [];
  if (!Array.isArray(directories) || directories.some(path => !safeRelative(path) || !PRIVATE_DIRECTORY.test(path))) throw WardrobeError.from("unsafe agent directory declaration");
  const seen = new Set();
  const files = declaration.files.map((entry,index) => {
    if (!entry || Object.keys(entry).some(key => !["source", "target", "mutable", "template"].includes(key)) || !safeRelative(entry.source) || !safeRelative(entry.target) || !TARGET.test(entry.target) || SECRET.test(entry.source) || SECRET.test(entry.target) || (entry.mutable !== undefined && typeof entry.mutable !== "boolean") || (entry.template !== undefined && typeof entry.template !== "boolean")) throw Object.assign(WardrobeError.from("unsafe wardrobe.agent file declaration"),{code:'AGENT_FILE_DECLARATION',diagnostics:[{path:'/wardrobe/agent/files/'+index,reason:'Use supported relative source/target and boolean mutable/template fields.',hint:'lookup source wardrobe:agent-files gives exact allowed keys and targets.'}]});
    if (entry.mutable && !MUTABLE.has(entry.target) && !/^habits\/[^/]+\.md$/.test(entry.target)) throw WardrobeError.from("only configuration seeds may be mutable: " + entry.target);
    if (seen.has(entry.target)) throw WardrobeError.from("duplicate agent file " + entry.target);
    seen.add(entry.target);
    const source = resolvePackagePath(root, entry.source, "/wardrobe/agent/files");
    if (!lstatSync(source).isFile()) throw WardrobeError.from("agent resource must be a regular file: " + entry.source);
    const bytes = readFileSync(source);
    if (entry.template) {
      JSON.parse(bytes.toString("utf8"));
      if (/\{\{(?!agentDir\}\}|node\}\})/.test(bytes.toString("utf8"))) throw WardrobeError.from("unknown agent file template variable");
    }
    return { package: alias, source: entry.source, target: entry.target, sha256: sha256(bytes), bytes: bytes.length, mutable: entry.mutable === true, template: entry.template === true };
  });
  if (bindings.some(binding => binding.kind === 'file' && files.some(file => file.target === binding.target))) throw WardrobeError.from('device binding conflicts with a package-owned agent file');
  return { files, settings, ...(directories.length ? { directories } : {}), ...(bindings.length ? { deviceBindings: bindings } : {}) };
}

export function combineAgentFiles(environments) {
  const files = [], settings = {}, directories = [];
  const bindings = validateBindings(environments.filter(Boolean).flatMap(environment => environment.deviceBindings || []));
  for (const environment of environments.filter(Boolean)) {
    directories.push(...(environment.directories ?? []));
    for (const file of environment.files) {
      if (files.some(previous => previous.target === file.target)) throw WardrobeError.from("conflicting agent file " + file.target);
      files.push(file);
    }
    for (const [key, value] of Object.entries(environment.settings)) {
      if (key in settings && JSON.stringify(settings[key]) !== JSON.stringify(value)) throw WardrobeError.from("conflicting agent setting " + key);
      settings[key] = value;
    }
  }
  if (bindings.some(binding => binding.kind === 'file' && files.some(file => file.target === binding.target))) throw WardrobeError.from('device binding conflicts with a package-owned agent file');
  return files.length || Object.keys(settings).length || directories.length || bindings.length ? { files, settings, ...(directories.length ? { directories: [...new Set(directories)] } : {}), ...(bindings.length ? { deviceBindings: bindings } : {}) } : null;
}

export function packageRootFor(plan, installed) {
  const root = plan.installationSurfaces.find(surface => surface.alias === installed.alias)?.resourceRoot;
  return root ? resolvePackagePath(installed.installedPath, root, "/installationSurfaces/resourceRoot") : installed.installedPath;
}

function fileBytes(plan, inventory, file, agentDir) {
  const installed = inventory.find(entry => entry.alias === file.package);
  if (!installed) throw WardrobeError.from("agent file package is not installed: " + file.package);
  const source = resolvePackagePath(packageRootFor(plan, installed), file.source, "/agent/files");
  const bytes = readFileSync(source);
  if (sha256(bytes) !== file.sha256) throw WardrobeError.from("approved agent file changed: " + file.source);
  if (!file.template) return bytes;
  const replace = value => typeof value === "string" ? value.replaceAll("{{agentDir}}", agentDir).replaceAll("{{node}}", process.execPath) : Array.isArray(value) ? value.map(replace) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value;
  return Buffer.from(JSON.stringify(replace(JSON.parse(bytes.toString("utf8"))), null, 2) + "\n");
}

function safeDestination(agentDir, target, create = false, createdDirectories = []) {
  if (!safeRelative(target) || !TARGET.test(target) || SECRET.test(target)) throw WardrobeError.from("unsafe agent file destination");
  let current = agentDir;
  for (const part of target.split("/")) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw WardrobeError.from("agent file destination is a symlink: " + target);
    if (current !== join(agentDir, target)) {
      if (info && !info.isDirectory()) throw WardrobeError.from("agent file parent is not a directory: " + target);
      if (!info && create) { mkdirSync(current); createdDirectories.push(current); }
    } else if (info && !info.isFile()) throw WardrobeError.from("agent file destination is not a regular file: " + target);
  }
  return current;
}

/** Returns rollback for newly created files if preflight or spawn fails. */
export function activateAgentFiles({ plan, inventory, agentDir }) {
  const created = [], createdDirectories = [];
  const rollback = () => {
    for (const path of [...created].reverse()) rmSync(path, { force: true });
    for (const path of [...createdDirectories].reverse()) { try { rmdirSync(path); } catch {} }
  };
  try {
    for (const directory of plan.agent?.directories ?? []) {
      if (!safeRelative(directory) || !PRIVATE_DIRECTORY.test(directory)) throw WardrobeError.from("unsafe private directory");
      let path = agentDir;
      for (const part of directory.split("/")) {
        path = join(path, part);
        const info = lstatSync(path, { throwIfNoEntry: false });
        if (info && (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077)))) throw WardrobeError.from("unsafe private directory: " + directory);
        if (!info) { mkdirSync(path, { mode: 0o700 }); createdDirectories.push(path); }
      }
    }
    for (const file of plan.agent?.files ?? []) {
      const path = safeDestination(agentDir, file.target, true, createdDirectories);
      const bytes = fileBytes(plan, inventory, file, agentDir);
      if (existsSync(path)) {
        if (!file.mutable && !readFileSync(path).equals(bytes)) throw WardrobeError.from("agent file differs from the approved resource: " + file.target);
      } else {
        writeFileSync(path, bytes, { flag: "wx", mode: file.target === "mcp.json" ? 0o600 : 0o644 });
        created.push(path);
      }
    }
    return rollback;
  } catch (error) { rollback(); throw error; }
}

/** Immutable activated copies must agree with the locked source. */
export function fingerprintAgentFiles({ plan, inventory, agentDir }) {
  return (plan.agent?.files ?? []).map(file => {
    const bytes = fileBytes(plan, inventory, file, agentDir);
    const target = safeDestination(agentDir, file.target);
    const actual = !file.mutable && existsSync(target) ? readFileSync(target) : bytes;
    return { package: file.package, kind: "agent-files", path: file.target, sha256: actual.equals(bytes) ? file.sha256 : sha256(actual), bytes: actual.equals(bytes) ? file.bytes : actual.length };
  });
}
