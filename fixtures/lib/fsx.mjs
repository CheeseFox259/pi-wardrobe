// Small filesystem helpers shared by the controlled native fixtures.
// Every path written by these helpers must stay inside the harness temporary root.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readBytes(path) {
  return readFileSync(path);
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonical absolute path. macOS resolves its temporary directory through a
 * symlink, so a path reported by a child process can differ from the one this
 * process created; comparing canonical forms keeps ownership assertions honest.
 */
export function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Digest of a file, or null when the file is absent. Never throws on absence. */
function digestFile(path) {
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}

/**
 * Digest of every regular file directly inside `dir`, keyed by file name.
 * Used to prove that unrelated sentinel files and installed preferences
 * survive native install and removal operations.
 */
export function digestDir(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, digestFile(`${dir}/${entry.name}`)])
  );
}

/** Depth-first search for `predicate`, returning the first match. */
export function findDir(start, predicate) {
  if (!existsSync(start)) return null;
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    if (predicate(current)) return current;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(`${current}/${entry.name}`);
    }
  }
  return null;
}
