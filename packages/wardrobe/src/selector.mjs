// Interactive startup selector for Wardrobe presets and revisions.
//
// Displayed when bare `wardrobe` or `pi --wardrobe` is invoked in an interactive
// terminal (TTY). Allows choosing an installed revision, selecting between
// follow and strict binding modes, and choosing between starting a fresh session
// or resuming a persisted one.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BindingStore, bindRequest } from "./binding.mjs";
import { diagnoseAll, resolvePresetKey } from "./revisions.mjs";

/**
 * List session files Pi persisted under a revision's session directory,
 * sorted by modification time (most recent first).
 */
export function listPersistedSessions(revisionDir) {
  if (!revisionDir) return [];
  const sessionsRoot = join(revisionDir, "wardrobe", "sessions");
  if (!existsSync(sessionsRoot)) return [];

  const files = [];
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json")) &&
        entry.name !== "session.json"
      ) {
        try {
          const stats = statSync(fullPath);
          files.push({
            path: fullPath,
            name: entry.name,
            mtime: stats.mtimeMs,
            date: stats.mtime.toISOString(),
          });
        } catch {}
      }
    }
  }

  return files.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Run the interactive startup selector on TTY streams.
 *
 * Resolves with `{ action: "launch", report, mode, presetKey, resume }` on confirmation,
 * or `{ action: "cancel", exitCode: 0 }` on cancellation.
 */
export async function runInteractiveSelector({
  agentDir,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const { reports, unreadable } = await diagnoseAll(agentDir, { env });
  const bindings = new BindingStore(agentDir);

  if (reports.length === 0) {
    stderr.write(
      "wardrobe: no installed revisions found in this agent directory\n" +
        (unreadable.length > 0
          ? `  unreadable: ${unreadable.map((u) => u.reason).join(", ")}\n`
          : "") +
        "  install a preset first: /wardrobe install <source> --confirm <digest>\n"
    );
    return { action: "cancel", exitCode: 1 };
  }

  return new Promise((resolve) => {
    let selectedIndex = 0;
    // Discriminated representation: { type: "fresh" } | { type: "resume", path: string, name: string, date: string }
    let selectedSession = { type: "fresh" };
    let errorMessage = null;
    let cleanedUp = false;
    let escapeTimer = null;

    const reportForIndex = () => reports[selectedIndex];

    const getBindingFor = (report) => {
      if (!report) return null;
      const canonical = resolvePresetKey(report.preset.id, reports);
      return canonical.ok ? bindings.read(canonical.presetKey) : null;
    };

    // Mode state for the currently highlighted revision
    let currentMode = getBindingFor(reportForIndex())?.mode ?? "follow";
    let persistedSessions = listPersistedSessions(reportForIndex()?.latest?.agentDir);

    const sessionChoices = () => [
      { type: "fresh" },
      ...persistedSessions.map((s) => ({
        type: "resume",
        path: s.path,
        name: s.name,
        date: s.date,
      })),
    ];

    const cycleSession = (direction) => {
      const choices = sessionChoices();
      const currentIndex = choices.findIndex((c) =>
        c.type === "fresh" ? selectedSession.type === "fresh" : c.path === selectedSession.path
      );
      const nextIndex = (currentIndex + direction + choices.length) % choices.length;
      selectedSession = choices[nextIndex];
      render();
    };

    const updateSelectedRevision = (newIndex) => {
      selectedIndex = Math.max(0, Math.min(newIndex, reports.length - 1));
      const rep = reportForIndex();
      currentMode = getBindingFor(rep)?.mode ?? "follow";
      persistedSessions = listPersistedSessions(rep?.latest?.agentDir);
      selectedSession = { type: "fresh" };
      errorMessage = null;
    };

    const render = () => {
      try {
        const rep = reportForIndex();
        const lines = [];

        // ANSI codes
        const bold = "\x1b[1m";
        const dim = "\x1b[2m";
        const reset = "\x1b[0m";
        const green = "\x1b[32m";
        const yellow = "\x1b[33m";
        const red = "\x1b[31m";
        const cyan = "\x1b[36m";

        lines.push(`${bold}=== Wardrobe Startup Selector ===${reset}`);
        lines.push(`${dim}Select a preset revision, binding mode, and session before Pi starts.${reset}\n`);

        lines.push(`${bold}Installed Revisions:${reset}`);
        for (let i = 0; i < reports.length; i += 1) {
          const item = reports[i];
          const isSelected = i === selectedIndex;
          const prefix = isSelected ? ` ${cyan}▸${reset} ` : "   ";
          const stateColor =
            item.state === "available" ? green : item.state === "drift" || item.state === "drifted" ? yellow : red;
          const name = item.preset.name || item.preset.id;
          const version = item.preset.version ? ` (${item.preset.version})` : "";
          lines.push(`${prefix}${bold}[${i + 1}]${reset} ${name}${version} ${stateColor}[${item.state}]${reset}`);
          if (isSelected) {
            lines.push(`       ${dim}Revision: ${item.revision}${reset}`);
            lines.push(`       ${dim}Preset:   ${item.preset.id}${reset}`);
            if (item.detail) {
              lines.push(`       ${yellow}Notice:   ${item.detail}${reset}`);
            }
          }
        }

        lines.push("");
        lines.push(`${bold}Binding Mode:${reset}`);
        const followMark = currentMode === "follow" ? `${green}[*]${reset}` : "[ ]";
        const strictMark = currentMode === "strict" ? `${green}[*]${reset}` : "[ ]";
        lines.push(`  ${followMark} follow: run newest approved revision (records migrations)`);
        lines.push(`  ${strictMark} strict: explicitly pin to revision ${rep?.revision}`);
        lines.push(`  ${dim}(press Tab, 'm', or Left/Right to toggle mode)${reset}`);

        lines.push("");
        lines.push(`${bold}Session:${reset}`);
        const freshMark = selectedSession.type === "fresh" ? `${green}[*]${reset}` : "[ ]";
        lines.push(`  ${freshMark} Fresh session (start a new conversation)`);
        if (persistedSessions.length > 0) {
          for (const sess of persistedSessions) {
            const sessMark =
              selectedSession.type === "resume" && selectedSession.path === sess.path
                ? `${green}[*]${reset}`
                : "[ ]";
            lines.push(`  ${sessMark} Resume: ${sess.name} ${dim}(${sess.date})${reset}`);
          }
        } else {
          lines.push(`  ${dim}  (no persisted sessions found for this revision)${reset}`);
        }
        lines.push(`  ${dim}(press 's', 'r', or Left/Right to choose session)${reset}`);

        if (errorMessage) {
          lines.push("");
          lines.push(`${red}${bold}! ${errorMessage}${reset}`);
        }

        lines.push("");
        lines.push(
          `${dim}Controls: [↑/↓] Revision  |  [Tab/m] Mode  |  [←/→/s] Session  |  [Enter] Launch  |  [Esc/q] Cancel${reset}`
        );

        // Clear screen and draw
        stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
      } catch (err) {
        cleanup();
        stderr.write(`wardrobe selector render error: ${err.message}\n`);
        resolve({ action: "cancel", exitCode: 1 });
      }
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }
      try {
        if (stdin.isTTY && typeof stdin.setRawMode === "function") {
          stdin.setRawMode(false);
        }
      } catch {}
      try {
        if (typeof stdin.pause === "function") {
          stdin.pause();
        }
      } catch {}
      try {
        stdin.removeListener("data", onData);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.removeListener("exit", onProcessExit);
        process.removeListener("uncaughtException", onUncaughtException);
      } catch {}
      try {
        stdout.write("\x1b[?25h"); // Restore cursor
      } catch {}
    };

    const onProcessExit = () => {
      cleanup();
    };

    const onUncaughtException = (err) => {
      cleanup();
      process.removeListener("uncaughtException", onUncaughtException);
      stderr.write(`wardrobe uncaught exception: ${err?.stack ?? err}\n`);
      process.exit(1);
    };

    const cancel = () => {
      cleanup();
      stdout.write("\nSelection cancelled.\n");
      resolve({ action: "cancel", exitCode: 0 });
    };

    const confirm = () => {
      const rep = reportForIndex();
      if (!rep) return;

      if (rep.state !== "available") {
        const diag = rep.detail || (rep.drift?.length ? rep.drift.map((d) => d.detail).join("; ") : rep.state);
        errorMessage = `Refused: revision ${rep.revision} is ${rep.state} (${diag}); cannot launch`;
        render();
        return;
      }

      cleanup();

      const canonical = resolvePresetKey(rep.preset.id, reports);
      if (canonical.ok) {
        try {
          const existing = bindings.read(canonical.presetKey);
          const req = bindRequest({
            preset: canonical.presetKey,
            mode: currentMode,
            revision: currentMode === "strict" ? rep.revision : null,
            previous: existing,
          });
          if (req.ok) {
            bindings.write(req.record);
          }
        } catch {}
      }

      const resumePath = selectedSession.type === "resume" ? selectedSession.path : null;

      resolve({
        action: "launch",
        report: rep,
        mode: currentMode,
        presetKey: canonical.ok ? canonical.presetKey : rep.preset.id,
        session: selectedSession,
        resume: resumePath,
      });
    };

    const processKey = (key) => {
      if (cleanedUp) return;

      if (key === "q" || key === "Q" || key === "\x03") {
        cancel();
        return;
      }

      if (key === "\x1b[A" || key === "k") {
        updateSelectedRevision(selectedIndex - 1);
        render();
        return;
      }

      if (key === "\x1b[B" || key === "j") {
        updateSelectedRevision(selectedIndex + 1);
        render();
        return;
      }

      if (key === "\t" || key === "m" || key === "M") {
        currentMode = currentMode === "follow" ? "strict" : "follow";
        render();
        return;
      }

      if (key === "f" || key === "F") {
        currentMode = "follow";
        render();
        return;
      }
      if (key === "p" || key === "P") {
        currentMode = "strict";
        render();
        return;
      }

      if (key === "s" || key === "S" || key === "r" || key === "R" || key === "\x1b[C" || key === "l") {
        cycleSession(1);
        return;
      }
      if (key === "\x1b[D" || key === "h") {
        cycleSession(-1);
        return;
      }

      if (key === "\r" || key === "\n") {
        confirm();
        return;
      }
    };

    const onData = (chunk) => {
      try {
        const str = String(chunk);

        // If an escape timer was pending and more data arrives, cancel timer
        if (escapeTimer) {
          clearTimeout(escapeTimer);
          escapeTimer = null;
        }

        // Standalone Escape key
        if (str === "\x1b") {
          escapeTimer = setTimeout(() => {
            cancel();
          }, 50);
          return;
        }

        if (str.startsWith("\x1b[")) {
          processKey(str);
          return;
        }

        for (const ch of str) {
          if (cleanedUp) break;
          processKey(ch);
        }
      } catch (err) {
        cleanup();
        stderr.write(`wardrobe selector error: ${err.message}\n`);
        resolve({ action: "cancel", exitCode: 1 });
      }
    };

    const onSigint = () => cancel();
    const onSigterm = () => {
      cleanup();
      stdout.write("\nTerminated.\n");
      resolve({ action: "cancel", exitCode: 128 + 15, signal: "SIGTERM" });
    };

    try {
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      process.on("exit", onProcessExit);
      process.on("uncaughtException", onUncaughtException);
      stdout.write("\x1b[?25l"); // Hide cursor
      render();
    } catch (err) {
      cleanup();
      stderr.write(`wardrobe: failed to initialize terminal raw mode: ${err.message}\n`);
      resolve({ action: "cancel", exitCode: 1 });
    }
  });
}
