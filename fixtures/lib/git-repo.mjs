// Build a controlled Git repository and serve it over loopback dumb HTTP.
//
// Shared by the fixture repository and by checks that need repositories the
// fixture does not ship: multi-preset repositories, equal ids across
// repositories, and repositories with resources that must be refused.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "./fsx.mjs";

/**
 * @param {{sandbox, server, name: string, commits: {message: string, files: Record<string,string>}[]}} input
 * @returns {Promise<{origin: string, commits: string[], sourceAt: (sha: string) => string, root: string}>}
 */
export async function buildGitRepo({ sandbox, server, name, commits }) {
  const work = join(sandbox.work, `repo-${name}`);
  ensureDir(work);

  const git = async (args, cwd = work) => {
    const result = await sandbox.runner.run("git", args, {
      cwd,
      env: sandbox.childEnv(),
    });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${result.code})\n${result.stderr}`);
    }
    return result.stdout.trim();
  };

  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Wardrobe Fixture"]);
  await git(["config", "commit.gpgsign", "false"]);

  const shas = [];
  for (const commit of commits) {
    for (const [file, contents] of Object.entries(commit.files ?? {})) {
      const target = join(work, file);
      ensureDir(dirname(target));
      writeFileSync(target, contents);
    }
    await git(["add", "-A"]);
    await git(["commit", "-m", commit.message]);
    shas.push(await git(["rev-parse", "HEAD"]));
  }

  const servedDir = join(sandbox.webroot, "git");
  ensureDir(servedDir);
  const bareName = `${name}.git`;
  const bare = join(servedDir, bareName);
  await git(["clone", "--bare", work, bare]);
  // Dumb HTTP needs a pre-generated ref advertisement.
  await git(["update-server-info"], bare);
  server.serveStatic("/git", servedDir);

  return {
    origin: server.origin,
    root: bare,
    commits: shas,
    sourceAt: (sha) => `git:${server.origin}/git/${bareName}@${sha}`,
  };
}
