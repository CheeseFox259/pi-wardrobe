// Reference preset delivery: Perfect Pi Engineering reference.
//
// Engineering passes through the same review/install/launch pipeline as
// community presets, capturing pinned native dependencies (@aliou/pi-guardrails@0.19.0,
// @narumitw/pi-lsp@0.49.9) and the curated 12 engineering skill families.
// The declarations match the approved V1 specification, and runtime observation
// verifies active tools, high reasoning, appended persona instructions, and truthful
// unavailability reporting without touching personal settings.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESULT_TYPE } from "../packages/wardrobe/extensions/wardrobe.mjs";
import { validateDefinition } from "../packages/wardrobe/src/schema.mjs";
import { useHarness } from "./support/harness.mjs";

const harness = useHarness("engineering-reference");
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MANAGER_DIR = resolve(REPO_ROOT, "packages", "wardrobe");
const CLI = join(MANAGER_DIR, "bin", "wardrobe.mjs");
const PRESET_DIR = join(REPO_ROOT, "presets", "engineering");
const SHIPPED_PRESET_FILE = join(PRESET_DIR, "preset.json");
const SHIPPED_PACKAGE_JSON = join(PRESET_DIR, "package.json");
const SHIPPED_README_FILE = join(PRESET_DIR, "README.md");
const SHIPPED_NOTICE_FILE = join(PRESET_DIR, "NOTICE");
const SHIPPED_LICENSE_FILE = join(PRESET_DIR, "LICENSE");
const SPEC_FILE = join(REPO_ROOT, "docs", "specs", "wardrobe-v1.md");

/** Extract the approved Engineering JSON example directly from the specification. */
function extractApprovedExample(specPath) {
  const content = readFileSync(specPath, "utf8");
  const heading = "#### Simplified Perfect Pi Engineering";
  const headingIndex = content.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`Section '${heading}' not found in ${specPath}`);
  }
  const afterHeading = content.slice(headingIndex + heading.length);
  const fenceMatch = afterHeading.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Approved code fence under '${heading}' not found in ${specPath}`);
  }
  const parsed = JSON.parse(fenceMatch[1]);
  if (parsed.id !== "perfect-pi/engineering") {
    throw new Error(`Expected preset id 'perfect-pi/engineering' in '${heading}' block, got ${parsed.id}`);
  }
  return parsed;
}

/** Recursively read directory files into an object tree for git commits. */
function readDirectoryTree(dir, prefix = "") {
  const files = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, readDirectoryTree(join(dir, entry.name), rel));
    } else {
      files[rel] = readFileSync(join(dir, entry.name), "utf8");
    }
  }
  return files;
}

/** Cached bare-git repositories so each is built once. */
const repos = {};

async function installManager(h) {
  await h.pi.runOk("primary", ["install", MANAGER_DIR]);
}

async function repo(h, name, commits) {
  repos[name] ??= await h.gitRepo(name, commits);
  return repos[name];
}

function launchEnv(h, extra = {}) {
  return h.sandbox.childEnv({
    agentDir: h.agentPath("primary"),
    extra: { WARDROBE_PI_CLI: h.runtime.cliPath, ...extra },
  });
}

async function wardrobe(h, argument, { extraEnv } = {}) {
  const session = await h.pi.rpc("primary", {
    extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/`, ...extraEnv },
  });
  try {
    await session.command(`wardrobe ${argument}`);
    const [result] = await session.readCustomEntries(RESULT_TYPE);
    return result.data;
  } finally {
    await session.close();
  }
}

/**
 * Launch a revision through the standalone launcher and speak Pi's protocol to it.
 */
function launched(h, revisionId, { revisionDir, args = [] } = {}) {
  const child = h.sandbox.runner.fork(
    process.execPath,
    [
      CLI,
      "--agent-dir",
      h.agentPath("primary"),
      "run",
      revisionId,
      "--",
      "--mode",
      "rpc",
      "--no-session",
      "--extension",
      h.pi.ensureDriver(),
      ...args,
    ],
    { cwd: h.sandbox.project, env: launchEnv(h) }
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

  let buffer = "";
  const rows = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Not an RPC protocol record.
      }
    }
  });

  let seq = 0;
  const send = (type, extra = {}) =>
    new Promise((resolvePromise) => {
      const id = `probe-${++seq}`;
      const started = Date.now();
      const poll = setInterval(() => {
        const row = rows.find((entry) => entry.id === id && entry.type === "response");
        if (!row && Date.now() - started < 30_000) return;
        clearInterval(poll);
        resolvePromise(row ?? null);
      }, 40);
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });

  const waitForCommands = async (expected, timeoutMs = 30_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = await send("get_commands");
      const names = (row?.data?.commands ?? []).map((command) => command.name);
      if (expected.every((name) => names.includes(name))) return row?.data?.commands ?? [];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`session never registered ${expected.join(", ")}\n${stderr.slice(0, 500)}`);
  };

  const command = async (name) => {
    const row = await send("prompt", { message: `/${name}` });
    if (!row?.success) throw new Error(`/${name} failed: ${JSON.stringify(row)}`);
    return row;
  };

  const useLocalModel = async () => {
    await command("fixture-use-local");
    const marker = join(revisionDir, "fixture-model.txt");
    assert.equal(existsSync(marker), true, "local model marker was not written");
    const chosen = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(chosen.chosen, true, `session did not take the local model: ${JSON.stringify(chosen)}`);
  };

  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    h.sandbox.runner.release(child);
    return code;
  };

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    h.sandbox.runner.release(child);
  };

  return { child, send, command, close, kill, waitForCommands, useLocalModel, stderr: () => stderr };
}

function sessionState(revisionDir) {
  const path = join(revisionDir, "fixture-state.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

function latestRequest(revisionDir) {
  const path = join(revisionDir, "fixture-request.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : JSON.parse(lines.at(-1));
}

async function waitForRequest(revisionDir, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const request = latestRequest(revisionDir);
    if (request) return request;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test("shipped Perfect Pi Engineering declaration matches the approved example and native manifest exactly", () => {
  assert.equal(existsSync(SHIPPED_PRESET_FILE), true, "presets/engineering/preset.json does not exist");
  assert.equal(existsSync(SHIPPED_PACKAGE_JSON), true, "presets/engineering/package.json does not exist");
  assert.equal(existsSync(SHIPPED_README_FILE), true, "presets/engineering/README.md does not exist");
  assert.equal(existsSync(SHIPPED_NOTICE_FILE), true, "presets/engineering/NOTICE does not exist");
  assert.equal(existsSync(SHIPPED_LICENSE_FILE), true, "presets/engineering/LICENSE does not exist");
  assert.equal(existsSync(SPEC_FILE), true, "docs/specs/wardrobe-v1.md does not exist");

  const rawPreset = readFileSync(SHIPPED_PRESET_FILE, "utf8");
  const parsedPreset = JSON.parse(rawPreset);

  // Extract the approved example directly from the authoritative specification (docs/specs/wardrobe-v1.md:115-139)
  const approved = extractApprovedExample(SPEC_FILE);
  assert.deepEqual(
    parsedPreset,
    approved,
    "shipped presets/engineering/preset.json drifted from approved example in docs/specs/wardrobe-v1.md"
  );

  // Validate according to strict schema
  const validation = validateDefinition(parsedPreset, { origin: SHIPPED_PRESET_FILE });
  assert.equal(validation.ok, true, `schema validation failed: ${validation.error?.format?.()}`);

  // Native package manifest matches explicit resource selection
  const rawPackageJson = readFileSync(SHIPPED_PACKAGE_JSON, "utf8");
  const parsedPackageJson = JSON.parse(rawPackageJson);
  const selfExtensions = approved.resources.find((r) => r.package === "self" && r.kind === "extensions");
  const selfSkills = approved.resources.find((r) => r.package === "self" && r.kind === "skills");

  assert.deepEqual(
    parsedPackageJson.pi?.extensions,
    selfExtensions.include,
    "package.json pi.extensions does not match approved explicit resource selection"
  );
  assert.deepEqual(
    parsedPackageJson.pi?.skills,
    selfSkills.include,
    "package.json pi.skills does not match approved explicit resource selection"
  );

  // All 12 curated skills exist on disk
  const expectedSkills = [
    "skills/route/SKILL.md",
    "skills/grilling/SKILL.md",
    "skills/domain-modeling/SKILL.md",
    "skills/project-architecture/SKILL.md",
    "skills/to-spec/SKILL.md",
    "skills/to-tickets/SKILL.md",
    "skills/implement/SKILL.md",
    "skills/tdd/SKILL.md",
    "skills/code-review/SKILL.md",
    "skills/verify-product/SKILL.md",
    "skills/research/SKILL.md",
    "skills/setup-matt-pocock-skills/SKILL.md",
  ];
  for (const skillPath of expectedSkills) {
    assert.equal(
      existsSync(join(PRESET_DIR, skillPath)),
      true,
      `declared skill missing on disk: ${skillPath}`
    );
    const skillContent = readFileSync(join(PRESET_DIR, skillPath), "utf8");
    assert.match(skillContent, /^---\n/, `${skillPath} missing YAML frontmatter`);
    assert.match(skillContent, /name:\s*[a-z0-9-]+/, `${skillPath} missing valid name frontmatter`);
    assert.match(skillContent, /description:\s*.+/, `${skillPath} missing description frontmatter`);
  }

  // Question extensions exist on disk
  assert.equal(existsSync(join(PRESET_DIR, "extensions", "question.ts")), true);
  assert.equal(existsSync(join(PRESET_DIR, "extensions", "questionnaire.ts")), true);

  // Author-facing documentation assertions
  const readme = readFileSync(SHIPPED_README_FILE, "utf8");
  assert.match(readme, /# Perfect Pi Engineering/);
  assert.match(readme, /question/);
  assert.match(readme, /questionnaire/);
  assert.match(readme, /lsp_diagnostics/);
  assert.match(readme, /lsp_fix/);
  assert.match(readme, /@aliou\/pi-guardrails@0\.19\.0/);
  assert.match(readme, /@narumitw\/pi-lsp@0\.49\.9/);
  assert.match(readme, /External Language Server/);
  assert.match(readme, /Guardrails Policy Boundaries/);
  assert.match(readme, /No Heavy Defaults/);
  assert.match(readme, /Prerequisite Truthfulness/);

  // Notice and audit assertions
  const notice = readFileSync(SHIPPED_NOTICE_FILE, "utf8");
  assert.match(notice, /@aliou\/pi-guardrails@0\.19\.0/);
  assert.match(notice, /@narumitw\/pi-lsp@0\.49\.9/);
  assert.match(notice, /extensions\/guardrails\/index\.ts/);
  assert.match(notice, /dist\/index\.ts/);
  assert.match(notice, /extensions\/question\.ts/);
  assert.match(notice, /extensions\/questionnaire\.ts/);
  assert.match(notice, /Truthful Unavailability/);
  assert.match(notice, /Independence & Clean Environment/);

  // License exists
  const license = readFileSync(SHIPPED_LICENSE_FILE, "utf8");
  assert.match(license, /MIT License/);
});

test("cancelling engineering reference review installs nothing and writes no staging revision", async () => {
  const h = harness();
  await installManager(h);

  await h.npmPackage("@aliou/pi-guardrails", [
    {
      version: "0.19.0",
      exitCode: 0,
      pi: { extensions: ["extensions/guardrails/index.ts"] },
      extraFiles: {
        "extensions/guardrails/index.ts": `export default function () {}`,
      },
    },
  ]);
  await h.npmPackage("@narumitw/pi-lsp", [
    {
      version: "0.49.9",
      exitCode: 0,
      pi: { extensions: ["dist/index.ts"] },
      extraFiles: {
        "dist/index.ts": `export default function () {}`,
      },
    },
  ]);

  const presetTree = readDirectoryTree(PRESET_DIR);
  const git = await repo(h, "engineering-cancelled", [
    {
      message: "feat: perfect pi engineering reference",
      files: presetTree,
    },
  ]);
  const source = git.sourceAt(git.commits[0]);

  // Review without --confirm
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  assert.equal(reviewed.state, "awaiting-approval");
  assert.equal(reviewed.installed, false);
  assert.match(reviewed.plan.digest, /^[0-9a-f]{64}$/);

  // Assert staging store was not created or holds no records
  const stagingDir = join(h.agentPath("primary"), "wardrobe", "staging");
  assert.equal(existsSync(stagingDir), false, "reviewing created staging directory without approval");

  const status = await wardrobe(h, "status");
  assert.equal(status.ok, true);
  assert.equal(status.revisions.length, 0, "status reported an installed revision after cancellation");

  h.record("engineering-cancellation-installs-nothing", {
    state: reviewed.state,
    installed: reviewed.installed,
    digest: reviewed.plan.digest,
  });
});

test("pinned Git fixture import reviews, approves, installs, and launches with effective runtime observations", async (t) => {
  const h = harness();
  await installManager(h);

  // 1. Loopback npm registry serves pinned fixture packages with explicit entries
  await h.npmPackage("@aliou/pi-guardrails", [
    {
      version: "0.19.0",
      exitCode: 0,
      pi: { extensions: ["extensions/guardrails/index.ts"] },
      extraFiles: {
        "extensions/guardrails/index.ts": `export default function (pi) {
          pi.registerCommand("guardrails-probe", {
            handler: async () => {},
          });
        }
`,
      },
    },
  ]);

  await h.npmPackage("@narumitw/pi-lsp", [
    {
      version: "0.49.9",
      exitCode: 0,
      pi: { extensions: ["dist/index.ts"] },
      extraFiles: {
        "dist/index.ts": `import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
  const executeLsp = async () => ({
    content: [{ type: "text", text: "LSP workflow unavailable: no language server installed or configured for this project." }],
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get file diagnostics",
    promptSnippet: "lsp_diagnostics(path) - get file diagnostics",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: executeLsp,
  });

  pi.registerTool({
    name: "lsp_fix",
    label: "LSP Quick Fix",
    description: "Apply LSP code actions",
    promptSnippet: "lsp_fix(path, action) - apply LSP code action",
    parameters: Type.Object({ path: Type.String() }),
    execute: executeLsp,
  });

  pi.registerCommand("lsp-probe", {
    handler: async () => {
      const outcome = await executeLsp();
      writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "probe-lsp-result.json"), JSON.stringify(outcome));
    },
  });
}
`,
      },
    },
  ]);

  // 2. Author engineering reference preset in bare git fixture
  const presetTree = readDirectoryTree(PRESET_DIR);
  const git = await repo(h, "engineering-git-import", [
    {
      message: "feat: perfect pi engineering reference",
      files: presetTree,
    },
  ]);
  const source = git.sourceAt(git.commits[0]);
  assert.match(source, /^git:.*@[0-9a-f]{40}$/, "Git source is not pinned to a full commit SHA");

  const beforeSnapshot = h.snapshotAgent("primary");

  // 3. Review via /wardrobe install
  const reviewed = await wardrobe(h, `install ${source}`);
  assert.equal(reviewed.ok, true, reviewed.text);
  assert.equal(reviewed.state, "awaiting-approval");
  assert.equal(reviewed.installed, false);
  assert.equal(reviewed.plan.source.kind, "git");
  assert.equal(reviewed.plan.source.commit, git.commits[0]);
  assert.equal(reviewed.plan.identity.id, "perfect-pi/engineering");
  assert.equal(reviewed.plan.runtime.thinking.value, "high");

  // Assert installation surfaces and resources
  const aliases = reviewed.plan.installationSurfaces.map((s) => s.alias).sort();
  assert.deepEqual(aliases, ["guardrails", "lsp", "self"]);

  const selfSurface = reviewed.plan.installationSurfaces.find((s) => s.alias === "self");
  assert.equal(selfSurface.source, ".");
  assert.equal(selfSurface.resolvesTo, source);

  assert.deepEqual(
    reviewed.plan.runtime.tools.enabled.map((e) => e.tool).sort(),
    ["lsp_diagnostics", "lsp_fix", "question", "questionnaire"]
  );
  assert.deepEqual(reviewed.plan.persona.append.map((e) => e.text), [
    "Use the project's domain language and architecture decisions. Preserve unrelated changes and report observed verification evidence.",
  ]);

  // 4. Approve and install
  const confirmed = await wardrobe(h, `install ${source} --confirm ${reviewed.plan.digest}`);
  assert.equal(confirmed.ok, true, confirmed.text);
  assert.equal(confirmed.state, "available", confirmed.text);
  assert.equal(confirmed.staging.state, "available");

  const revisionDir = confirmed.staging.agentDir;
  assert.ok(existsSync(revisionDir), "staged revision agent directory does not exist");

  // 5. Launch through standalone launcher
  const session = launched(h, confirmed.plan.planId, { revisionDir });
  t.after(() => session.kill());

  const expectedCommands = [
    "fixture-state",
    "wardrobe",
    "guardrails-probe",
    "lsp-probe",
    "skill:route",
    "skill:grilling",
    "skill:domain-modeling",
    "skill:project-architecture",
    "skill:to-spec",
    "skill:to-tickets",
    "skill:implement",
    "skill:tdd",
    "skill:code-review",
    "skill:verify-product",
    "skill:research",
    "skill:setup-matt-pocock-skills",
  ];
  const registeredCommands = await session.waitForCommands(expectedCommands);
  assert.ok(registeredCommands.length >= expectedCommands.length);

  // 6. Assert source provenance: all loaded skills and extensions come from inside the revision
  const presetCommands = expectedCommands.filter(
    (name) => name !== "fixture-state" && name !== "wardrobe"
  );
  for (const cmdName of presetCommands) {
    const found = registeredCommands.find((c) => c.name === cmdName);
    if (!found || !found.sourceInfo?.path) continue;
    assert.ok(
      found.sourceInfo.path.startsWith(revisionDir),
      `command ${cmdName} loaded from ${found.sourceInfo.path}, outside revision directory ${revisionDir}`
    );
    assert.equal(
      found.sourceInfo.path.includes(REPO_ROOT + "/presets/engineering"),
      false,
      `command ${cmdName} escaped revision and pointed directly at working tree`
    );
  }

  // 7. Verify runtime tools and thinking level
  await session.useLocalModel();
  await session.command("fixture-state");

  const settings = JSON.parse(readFileSync(join(revisionDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.deepEqual(
    settings.defaultTools.sort(),
    ["+lsp_diagnostics", "+lsp_fix", "+question", "+questionnaire"]
  );
  const guardrailsDecl = settings.packages.find((p) => p.source.includes("@aliou/pi-guardrails"));
  assert.deepEqual(guardrailsDecl.extensions, ["extensions/guardrails/index.ts"]);
  assert.deepEqual(guardrailsDecl.skills, []);
  const lspDecl = settings.packages.find((p) => p.source.includes("@narumitw/pi-lsp"));
  assert.deepEqual(lspDecl.extensions, ["dist/index.ts"]);
  assert.deepEqual(lspDecl.skills, []);
  const selfDecl = settings.packages.find((p) => p.source === source);
  assert.deepEqual(selfDecl.extensions.sort(), ["extensions/question.ts", "extensions/questionnaire.ts"]);
  assert.equal(selfDecl.skills.length, 12);

  const state = sessionState(revisionDir);
  assert.ok(state, "session never reported fixture-state");
  assert.deepEqual(
    state.tools.sort(),
    ["lsp_diagnostics", "lsp_fix", "question", "questionnaire"]
  );
  assert.equal(state.thinkingLevel, "high");
  assert.equal(state.model, "wardrobe-local/fixture-local");

  // Observe question and questionnaire extension loading through ordinary tool registry surfaces
  assert.ok(state.allTools.includes("question"), "question tool missing from session allTools");
  assert.ok(state.allTools.includes("questionnaire"), "questionnaire tool missing from session allTools");
  for (const toolName of ["question", "questionnaire", "lsp_diagnostics", "lsp_fix"]) {
    const toolInfo = state.toolSources?.find((t) => t.name === toolName);
    assert.ok(toolInfo, `expected tool ${toolName} in toolSources`);
    if (toolInfo.path) {
      assert.ok(
        toolInfo.path.startsWith(revisionDir),
        `tool ${toolName} loaded from ${toolInfo.path}, outside revision directory ${revisionDir}`
      );
      assert.equal(
        toolInfo.path.includes(REPO_ROOT + "/presets/engineering"),
        false,
        `tool ${toolName} escaped revision and pointed directly at working tree`
      );
    }
  }

  // 8. Send turn and assert model request boundary
  const asked = await session.send("prompt", { message: "verify engineering reference runtime" });
  assert.equal(asked?.success, true, JSON.stringify(asked));

  const request = await waitForRequest(revisionDir);
  assert.ok(request, "model request was not recorded");
  assert.equal(request.reasoning, "high", `expected reasoning high, got ${request.reasoning}`);
  assert.ok(
    request.systemPrompt.includes(
      "Use the project's domain language and architecture decisions. Preserve unrelated changes and report observed verification evidence."
    ),
    "system prompt does not include appended instruction"
  );
  assert.match(request.systemPrompt, /- lsp_diagnostics:/);
  assert.match(request.systemPrompt, /- lsp_fix:/);
  assert.match(request.systemPrompt, /- question:/);
  assert.match(request.systemPrompt, /- questionnaire:/);

  // 9. Unavailability truthfulness:
  // Trigger the LSP probe command: language server is absent, reports unavailable truthfully
  await session.command("lsp-probe");
  const lspOutputMarker = join(revisionDir, "probe-lsp-result.json");
  assert.equal(existsSync(lspOutputMarker), true, "LSP probe marker was not written");
  const lspOutput = JSON.parse(readFileSync(lspOutputMarker, "utf8"));
  assert.match(
    lspOutput.content?.[0]?.text,
    /LSP workflow unavailable: no language server installed or configured/
  );

  // Available tools (question, questionnaire) remain loaded and available without failure
  assert.ok(state.tools.includes("question"));
  assert.ok(state.tools.includes("questionnaire"));

  await session.close();

  // 10. Personal agent directory untouched
  const afterSnapshot = h.snapshotAgent("primary");
  assert.equal(afterSnapshot["auth.json"], beforeSnapshot["auth.json"]);
  assert.equal(afterSnapshot["unrelated.txt"], beforeSnapshot["unrelated.txt"]);
  assert.equal(afterSnapshot["settings.json"], beforeSnapshot["settings.json"]);

  h.record("engineering-reference-import-verified", {
    commit: git.commits[0],
    source,
    planId: confirmed.plan.planId,
    digest: confirmed.plan.digest,
    revisionDir,
    tools: state.tools,
    thinking: state.thinkingLevel,
    reasoning: request.reasoning,
    personalStatePreserved: true,
  });
});
