import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { preflightLaunch } from "../packages/wardrobe/src/launch.mjs";
import { runCommand } from "../packages/wardrobe/src/commands.mjs";
import { RpcSession } from "../fixtures/lib/pi-runner.mjs";
import { launchEnv, useHarness } from "./support/harness.mjs";

const harness = useHarness("nested-package");
const CLI = fileURLToPath(new URL("../packages/wardrobe/bin/wardrobe.mjs", import.meta.url));

test("a preset shipped in a repository subpackage installs and loads its approved resources", async (t) => {
  const h = harness();
  const repo = await h.gitRepo("nested-package", [{
    message: "nested native package",
    files: {
      "package.json": JSON.stringify({ name: "fixture-workspace", version: "1.0.0" }),
      "presets/coding/package.json": JSON.stringify({
        name: "nested-coding", version: "1.0.0", type: "module",
        pi: { extensions: ["extensions/check.mjs"], skills: ["skills/check/SKILL.md"] },
        wardrobe: { agent: {
          schemaVersion: 1,
          files: [
            { source: "support/check.json", target: "scripts/check.json", template: true },
            { source: "support/default.json", target: "sol-pi.json", mutable: true },
          ],
          settings: { enableSkillCommands: true },
        } },
      }),
      "presets/coding/preset.json": JSON.stringify({
        schemaVersion: 1, id: "nested/coding", name: "Nested Coding", version: "1.0.0",
        compatibility: { pi: h.runtime.version }, packages: { self: { source: "." } },
        resources: [
          { package: "self", kind: "extensions", include: ["extensions/check.mjs"] },
          { package: "self", kind: "skills", include: ["skills/check/SKILL.md"] },
        ],
      }),
      "presets/coding/extensions/check.mjs": 'import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nexport default pi => { const config = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "scripts/check.json"))); if(config.agentDir !== process.env.PI_CODING_AGENT_DIR) throw new Error("agent template not resolved"); pi.registerCommand("nested-check", { handler: async () => {} }); };\n',
      "presets/coding/support/check.json": JSON.stringify({ agentDir: "{{agentDir}}", node: "{{node}}" }),
      "presets/coding/support/default.json": JSON.stringify({ enabled: true }),
      "presets/coding/skills/check/SKILL.md": "---\nname: nested-check\ndescription: Check the nested package.\n---\nCheck the project.\n",
    },
  }]);
  const env = launchEnv(h);
  const source = repo.sourceAt(repo.commits[0]);
  const request = `install ${source} --preset presets/coding/preset.json`;
  const review = await runCommand(request, { env });
  assert.equal(review.ok, true, JSON.stringify(review.result));
  const install = await runCommand(`${request} --confirm ${review.result.plan.digest}`, { env });
  assert.equal(install.ok, true, JSON.stringify(install.result.error));
  assert.equal(install.result.state, "available");
  assert.equal(existsSync(join(install.result.staging.agentDir, "scripts/check.json")), false, "agent resources must remain inactive before explicit launch");
  assert.equal(review.result.plan.agent.files.length, 2, "agent footprint must be visible in the approval plan");
  const revision = install.result.staging.revision;
  const doctor = await runCommand(`doctor ${revision}`, { env });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.result.revisions[0].state, "available");

  const child = h.sandbox.runner.fork(process.execPath, [
    CLI, "run", revision, "--agent-dir", h.agentPath("primary"), "--", "--mode", "rpc", "--offline", "--no-session",
  ], { cwd: h.sandbox.project, env });
  const session = new RpcSession(child, h.sandbox.runner, {
    agentName: "nested", agentDir: install.result.staging.agentDir,
    eventsLog: h.sandbox.extensionLog,
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const commands = await session.commandNames();
  assert.ok(commands.includes("nested-check"), session.stderr);
  assert.ok(commands.includes("skill:nested-check"), session.stderr);
  assert.ok(commands.includes("wardrobe"), session.stderr);
  assert.equal((await session.close()).code, 0);
  const config = JSON.parse(readFileSync(join(install.result.staging.agentDir, "scripts/check.json")));
  assert.equal(config.node, process.execPath);
  writeFileSync(join(install.result.staging.agentDir, "sol-pi.json"), '{"enabled":false}\n');
  const unchanged = await runCommand("doctor " + revision, { env });
  assert.equal(unchanged.result.revisions[0].state, "available", "mutable defaults are not immutable code");
  const settingsPath = join(install.result.staging.agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath));
  settings.defaultProvider = "cpa";
  settings.defaultModel = "saved-choice";
  settings.terminal = { showImages: false };
  settings.enabledModels = ["cpa/saved-choice"];
  settings.modelThinkingLevels = {"cpa/saved-choice":"high"};
  writeFileSync(settingsPath, JSON.stringify(settings));
  const next = await preflightLaunch({ agentDir: h.agentPath("primary"), selector: revision, env, runId: "saved-preference", cwd: h.sandbox.project });
  assert.equal(next.activation.defaultModel, "saved-choice");
  assert.deepEqual(next.activation.terminal, settings.terminal);
  assert.deepEqual(next.activation.enabledModels, settings.enabledModels);
  assert.deepEqual(next.activation.modelThinkingLevels, settings.modelThinkingLevels);
  writeFileSync(join(install.result.staging.agentDir, "scripts/check.json"), "{}\n");
  const drifted = await runCommand("doctor " + revision, { env });
  assert.equal(drifted.result.revisions[0].state, "drifted", "modified activated helper code must be diagnosed");
  const installed = doctor.result.revisions[0].latest.installed.find(entry => entry.alias === "self");
  rmSync(join(install.result.staging.agentDir, installed.installedRelative, "presets/coding"), { recursive: true });
  const missing = await runCommand("doctor " + revision, { env });
  assert.equal(missing.ok, true, "missing nested root must be diagnosed rather than aborting doctor");
  assert.notEqual(missing.result.revisions[0].state, "available");
});
