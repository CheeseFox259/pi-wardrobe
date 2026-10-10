// Controlled Bare Git source served over loopback dumb HTTP.
//
// Two immutable full commits are built locally and published as a bare
// repository, so `pi install git:http://127.0.0.1:<port>/...@<full-sha>`
// exercises real Git cloning and ref reconciliation rather than local-path
// loading.
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, findDir, readJson } from "./fsx.mjs";
import { writeFixturePackage } from "./payloads.mjs";

const REPO_NAME = "wardrobe-git-fixture";
const BARE_DIRNAME = `${REPO_NAME}.git`;

export class GitSourceFixture {
  constructor({ sandbox, server, commits, markerLog, extensionLog }) {
    this.sandbox = sandbox;
    this.server = server;
    this.commits = commits;
    this.markerLog = markerLog;
    this.extensionLog = extensionLog;
  }

  static async create({ sandbox, server }) {
    const markerLog = sandbox.markerLog;
    const extensionLog = sandbox.extensionLog;
    const git = (args, cwd) =>
      sandbox.runner.run("git", args, {
        cwd,
        env: sandbox.childEnv(),
      }).then((result) => {
        if (result.code !== 0) {
          throw new Error(
            `git ${args.join(" ")} failed (${result.code})\n${result.stderr}`
          );
        }
        return result.stdout.trim();
      });

    const work = join(sandbox.work, "git-source");
    ensureDir(work);
    await git(["init", "-b", "main"], work);
    await git(["config", "user.email", "fixture@example.invalid"], work);
    await git(["config", "user.name", "Wardrobe Fixture"], work);
    await git(["config", "commit.gpgsign", "false"], work);

    const commits = {};
    for (const revision of ["v1", "v2"]) {
      const version = revision === "v1" ? "1.0.0" : "2.0.0";
      writeFixturePackage(work, {
        name: REPO_NAME,
        version,
        markerLog,
        source: "git",
        extensionLog,
      });
      writeFileSync(join(work, "revision.txt"), `${revision}\n`);
      await git(["add", "-A"], work);
      await git(["commit", "-m", `fixture ${revision}`], work);
      commits[revision] = await git(["rev-parse", "HEAD"], work);
    }

    const servedDir = join(sandbox.webroot, "git");
    ensureDir(servedDir);
    const bare = join(servedDir, BARE_DIRNAME);
    await git(["clone", "--bare", work, bare]);
    // Dumb HTTP needs a pre-generated ref advertisement.
    await git(["update-server-info"], bare);

    server.serveStatic("/git", servedDir);

    return new GitSourceFixture({
      sandbox,
      server,
      commits,
      markerLog,
      extensionLog,
    });
  }

  /** A Pi-supported Git source URL pinned to a full commit SHA. */
  sourceAt(sha) {
    return `git:${this.server.origin}/git/${BARE_DIRNAME}@${sha}`;
  }

  sourceFor(revision) {
    return this.sourceAt(this.commits[revision]);
  }

  /**
   * The persistent native checkout Pi maintains for this source inside one agent
   * directory. Discovered rather than assumed, so the harness does not encode
   * Pi's internal path layout.
   */
  checkoutIn(agentDirPath) {
    return findDir(
      join(agentDirPath, "git"),
      (dir) =>
        existsSync(join(dir, "package.json")) &&
        readJson(join(dir, "package.json")).name === REPO_NAME
    );
  }
}
