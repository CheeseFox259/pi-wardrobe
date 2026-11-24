// Pi 1.1.0 compatibility bridge: resource isolation, native model ownership.
// Loaded only in Wardrobe preset processes. Pi reads/writes its original stores
// (and uses their original locks); credentials never enter the preset or revision.
import { dirname, join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const nativeDir = process.env.WARDROBE_NATIVE_AGENT_DIR;
const revisionDir = process.env.PI_CODING_AGENT_DIR;
const revisionRoot = process.env.WARDROBE_NATIVE_REVISION_ROOT;
const isPiChild = process.argv[1] && process.env.WARDROBE_PI_CLI
  && resolve(process.argv[1]) === resolve(process.env.WARDROBE_PI_CLI);
if (isPiChild && nativeDir && revisionDir && revisionRoot
    && dirname(resolve(revisionDir)) === resolve(revisionRoot)
    && resolve(nativeDir) !== resolve(revisionDir)) {
  const dist = dirname(process.env.WARDROBE_PI_CLI);
  const load = name => import(pathToFileURL(join(dist, 'core', name + '.js')).href);
  const [{ ModelRuntime }, { AuthStorage }, { SettingsManager }] = await Promise.all([
    load('model-runtime'), load('auth-storage'), load('settings-manager'),
  ]);
  const [{ DefaultResourceLoader }, { loadSkills }] = await Promise.all([load('resource-loader'), load('skills')]);
  const registry = JSON.parse(readFileSync(join(nativeDir, 'wardrobe/native.json'), 'utf8'));
  const selected = registry.profiles[process.env.WARDROBE_NATIVE_PROFILE]?.selectedSkills ?? [];
  const updateSkills = DefaultResourceLoader.prototype.updateSkillsFromPaths;
  DefaultResourceLoader.prototype.updateSkillsFromPaths = function(paths, metadata) {
    if (resolve(this.agentDir) !== resolve(revisionDir) || !selected.length) return updateSkills.call(this, paths, metadata);
    // Reuse Pi's resolved, trust-filtered paths. New personal/project skills are
    // discovered by Pi on every load; approved preset skills win equal names.
    const preferred = [...new Set(selected.flatMap(selection => paths.flatMap(path =>
      selection === path || selection.startsWith(path + sep) ? [selection]
        : path.startsWith(selection + sep) ? [path] : [])))];
    const loaded = loadSkills({ cwd: this.cwd, agentDir: this.agentDir, skillPaths: [...preferred, ...paths], includeDefaults: false });
    updateSkills.call(this, loaded.skills.map(skill => skill.filePath), metadata);
    this.skillDiagnostics.push(...loaded.diagnostics.filter(entry => entry.type !== 'collision'));
  };
  const isRevisionFile = (path, name) => path === undefined || typeof path === 'string' && resolve(path) === join(resolve(revisionDir), name);
  const createAuth = AuthStorage.create;
  AuthStorage.create = function(path) {
    return createAuth.call(this, isRevisionFile(path, 'auth.json') ? join(nativeDir, 'auth.json') : path);
  };
  const createModels = ModelRuntime.create;
  ModelRuntime.create = function(options = {}) {
    return createModels.call(this, isRevisionFile(options.modelsPath, 'models.json') ? {
      ...options, modelsPath: join(nativeDir, 'models.json'),
      ...(isRevisionFile(options.authPath, 'auth.json') ? {authPath:join(nativeDir, 'auth.json')} : {}),
    } : options);
  };
  const createSettings = SettingsManager.create;
  // Delegate model operations to a native Pi SettingsManager. UI/resource writes
  // remain revision-local. Native project trust and project overrides still apply.
  const methods = [
    'getDefaultProvider', 'getDefaultModel', 'setDefaultProvider', 'setDefaultModel', 'setDefaultModelAndProvider',
    'getEnabledModels', 'setEnabledModels', 'getDefaultThinkingLevel', 'setDefaultThinkingLevel',
    'getModelThinkingLevel', 'getAllModelThinkingLevels', 'setModelThinkingLevel', 'removeModelThinkingLevel',
    'getTransport', 'setTransport', 'getRetrySettings', 'getRetryEnabled', 'setRetryEnabled', 'getProviderRetrySettings', 'getHttpIdleTimeoutMs', 'setHttpIdleTimeoutMs',
    'getWebSocketConnectTimeoutMs', 'getCacheWarmingMode', 'setCacheWarmingMode', 'getThinkingBudgets',
  ];
  const fields = ['defaultProvider', 'defaultModel', 'enabledModels', 'defaultThinkingLevel', 'modelThinkingLevels',
    'transport', 'retry', 'httpIdleTimeoutMs', 'websocketConnectTimeoutMs', 'cacheWarming', 'thinkingBudgets'];
  SettingsManager.create = function(cwd, agentDir = revisionDir, options = {}) {
    const local = createSettings.call(this, cwd, agentDir, options);
    if (resolve(agentDir) !== resolve(revisionDir)) return local;
    const native = createSettings.call(this, cwd, nativeDir, options);
    for (const name of methods) {
      if (typeof native[name] !== 'function') throw new Error(`Unsupported Pi settings API: ${name}`);
      local[name] = native[name].bind(native);
    }
    for (const name of ['getSettings', 'getGlobalSettings', 'getProjectSettings']) {
      const original = local[name].bind(local);
      local[name] = () => {
        const result = original(), source = native[name]();
        for (const key of fields) { delete result[key]; if (Object.hasOwn(source,key)) result[key]=source[key]; }
        return result;
      };
    }
    for (const name of ['setProjectTrusted', 'reload', 'flush']) {
      const original = local[name].bind(local);
      local[name] = name === 'setProjectTrusted'
        ? (...args) => { original(...args); return native[name](...args); }
        : async (...args) => { await original(...args); return native[name](...args); };
    }
    const drainErrors = local.drainErrors.bind(local);
    local.drainErrors = () => [...drainErrors(), ...native.drainErrors()];
    return local;
  };
}
