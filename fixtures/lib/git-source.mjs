// Controlled Bare Git source served over loopback dumb HTTP.
//
// Two immutable full commits are built locally and published as a bare
// repository, so `pi install git:http://127.0.0.1:<port>/...@<full-sha>`
// exercises real Git cloning and ref reconciliation rather than local-path
// loading.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, findDir, readJson } from "./fsx.mjs";
import { buildGitRepo } from "./git-repo.mjs";
import { writeFixturePackage } from "./payloads.mjs";

const REPO_NAME = "wardrobe-git-fixture";

export class GitSourceFixture {
  constructor({ sandbox, server, commits, markerLog, extensionLog, repo }) {
    this.sandbox = sandbox;
    this.server = server;
    this.commits = commits;
    this.markerLog = markerLog;
    this.extensionLog = extensionLog;
    this.repo = repo;
  }

  static async create({ sandbox, server }) {
    const markerLog = sandbox.markerLog;
    const extensionLog = sandbox.extensionLog;

    // Each commit is authored in its own scratch directory so the files of a
    // commit are explicit rather than whatever the previous one left behind.
    const revisions = ["v1", "v2"];
    const commits = [];
    for (const revision of revisions) {
      const version = revision === "v1" ? "1.0.0" : "2.0.0";
      const stage = join(sandbox.work, `stage-${revision}`);
      ensureDir(stage);
      writeFixturePackage(stage, {
        name: REPO_NAME,
        version,
        markerLog,
        source: "git",
        extensionLog,
      });
      writeRevision(stage, revision);
      commits.push({ message: `fixture ${revision}`, from: stage });
    }

    const repo = await buildGitRepo({
      sandbox,
      server,
      name: REPO_NAME,
      commits: commits.map(({ message, from }) => ({
        message,
        files: readTree(from),
      })),
    });

    return new GitSourceFixture({
      sandbox,
      server,
      commits: Object.fromEntries(revisions.map((rev, index) => [rev, repo.commits[index]])),
      markerLog,
      extensionLog,
      repo,
    });
  }

  /** A Pi-supported Git source URL pinned to a full commit SHA. */
  sourceAt(sha) {
    return this.repo.sourceAt(sha);
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

function writeRevision(stage, revision) {
  writeFileSync(join(stage, "revision.txt"), `${revision}\n`);
}

/** Flatten a staged directory into the file map `buildGitRepo` commits. */
function readTree(root) {
  const files = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else files[relative] = readFileSync(join(dir, entry.name), "utf8");
    }
  };
  walk(root, "");
  return files;
}
