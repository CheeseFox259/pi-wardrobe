# Pi Wardrobe V1: Usage & Preset Authoring Guide

Pi Wardrobe manages presets for the Pi CLI agent (v1.1.0). It provides reproducible preset lifecycle management: discovery, review, inactive staging, isolated process launch, idle in-session soft changes, follow and strict session resume, branch reconciliation, and owned revision removal.

---

## 1. Installation & Getting Started

### Prerequisites and Verified Baseline
- **Verified Platform:** macOS arm64 (`darwin arm64`)
- **Verified Runtime:** Pi 1.1.0, Node v26.5.0, npm 11.17.0
- **Unknown Platforms:** Linux, Windows, x86_64 architectures, and other Node/Pi version combinations remain **explicitly unverified, not certified**.

### Installing the Manager
Install `@pi-wardrobe/manager` into your Pi environment:
```sh
pi install /path/to/pi-wardrobe/packages/wardrobe
```
The manager package declares zero runtime dependencies, zero install scripts, and zero MCP servers, browser tooling, or skills. Installing the manager registers exactly one command, `/wardrobe`, and never auto-installs presets.

### Verifying Installation
Inside an interactive Pi session:
```
/wardrobe status
```
Outside Pi in a terminal, verify the launcher executable:
```sh
wardrobe
```
*(Running bare `wardrobe` in a TTY opens the interactive startup selector; inspecting revision state is performed inside Pi sessions via `/wardrobe status` or `/wardrobe doctor`.)*

---

## 2. Command Reference

### In-Session Commands (`/wardrobe`)
Inside an interactive Pi session, `/wardrobe` provides inspection, discovery, and in-place configuration:

| Command | Description |
| ------- | ----------- |
| `/wardrobe list` | Discovers available `preset.json` declarations in configured source roots; strictly read-only. |
| `/wardrobe show <preset>` | Displays preset identity, version, source, composed layers, and resource selectors. |
| `/wardrobe explain <preset>` | Traces every composed value to its layer and revision, reporting reasons for exclusions and proposals. |
| `/wardrobe explain <preset> --overlay <path>` | Evaluates a soft session overlay (`tools`, `model`, `thinking`, `persona`). |
| `/wardrobe explain <preset> --disable-tool <t1,t2>` | Evaluates CLI tool restrictions; exclusions survive all layers. |
| `/wardrobe explain <preset> --model <provider/id>` | Evaluates an explicit user model choice, which wins over declared preferences. |
| `/wardrobe install <source>` | Discovers a source (Bare Git or npm) and creates an immutable review plan. Installs nothing. |
| `/wardrobe install <source> --preset <path>` | Explicit preset selection when a repository contains multiple presets. |
| `/wardrobe install <source> --confirm <digest>` | Noninteractive approval bound to the displayed plan digest. Stages resources inactive. |
| `/wardrobe status [revision]` | Reports effective vs recorded state, active leases, bindings, and turn blocks. |
| `/wardrobe doctor [revision]` | Re-measures files against locks; diagnoses `available`, `drifted`, `unverified`, `failed`, or `missing`. |
| `/wardrobe bind [preset] [--mode follow\|strict] [--revision <id>]` | Sets durable binding mode. Follow resolves newest approved revision; strict pins exact revision. |
| `/wardrobe use <revision>` | Applies soft changes in place if executable state matches; returns a new-process launch plan if code differs. |
| `/wardrobe remove <preset> [--revision <id>]` | Deletes unreferenced owned staging revisions. Refuses wholesale if any revision is referenced. |
| `/wardrobe release <preset> --revision <id>` | Drops an explicit retention reference without deleting transcripts or altering strict bindings. |
| `/wardrobe retain [preset] [--revision <id>]` | Explicitly retains a revision against removal, or lists all active retain references. |

### Standalone CLI Commands (`wardrobe`)
The standalone launcher runs verified revisions in isolated child processes.

> **Important:** `wardrobe run` and `wardrobe use` **strictly require an explicit agent directory** (`--agent-dir <path>` or the `WARDROBE_AGENT_DIR` environment variable), and exit with code 2 otherwise. `PI_CODING_AGENT_DIR` is deliberately rejected by the launcher to avoid launching into a caller's personal environment.

```sh
# Interactive TTY startup selector
wardrobe

# Launch a verified revision or bound preset directly (requires explicit agent directory)
wardrobe run <revision|preset> --agent-dir <path> [--resume <session-file>] [-- <pi-args...>]
# or: WARDROBE_AGENT_DIR=<path> wardrobe run <revision|preset> [--resume <session-file>] [-- <pi-args...>]

# Emit the new-process launch plan without starting a process (requires explicit agent directory)
wardrobe use <revision|preset> --agent-dir <path>
# or: WARDROBE_AGENT_DIR=<path> wardrobe use <revision|preset>

# Shell/PATH integration
wardrobe integrate enable --dir <dir>
wardrobe integrate disable --dir <dir>
```

---

## 3. Reference Presets Availability

The repository includes two concrete reference presets under `presets/`. They are shipped as reviewable source examples and are **never automatically installed** when installing the manager:

### Minimal Coding (`presets/minimal-coding/`)
- **Identity:** `wardrobe/minimal-coding`, version 1.0.0
- **Scope:** Native-only baseline declaring built-in tools (`read`, `edit`, `write`, `bash`), `medium` thinking level, and concise persona guidelines.
- **Dependencies:** Zero external packages, zero MCP servers, zero skill frameworks.
- **Authoring Contract:** Pure declaration with no dependencies; passes standard discovery, review, and inactive staging.

### Perfect Pi Engineering (`presets/engineering/`)
- **Identity:** `perfect-pi/engineering`, version 1.0.0
- **Scope:** Engineering toolchain declaring 12 curated skill families, question and questionnaire extensions, and high reasoning.
- **Dependencies:** Pinned native packages `@aliou/pi-guardrails@0.19.0` and `@narumitw/pi-lsp@0.49.9`.
- **Honest Unavailability:** Language server executables (LSP) and skill prerequisites not present on the host are truthfully reported as missing/unmet; they are **never auto-installed** and personal settings are never modified.

---

## 4. Preset Authoring Contract (`preset.json`)

A preset is defined by a `preset.json` file conforming to `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "id": "my-preset",
  "name": "My Preset",
  "version": "1.0.0",
  "description": "Optional human summary",
  "author": "Author Name",
  "compatibility": {
    "pi": ">=1.1.0 <2.0.0",
    "platforms": ["darwin arm64"]
  },
  "extends": {
    "source": "git:https://example.com/base.git@0123456789abcdef0123456789abcdef01234567",
    "presetPath": "presets/base/preset.json"
  },
  "packages": {
    "tools": { "source": "npm:example-tools@1.2.0" },
    "local": { "source": "." }
  },
  "resources": [
    {
      "package": "tools",
      "kind": "skills",
      "include": ["skills/review/SKILL.md"],
      "exclude": ["skills/experimental/**"]
    },
    {
      "package": "local",
      "kind": "extensions",
      "include": ["extension.mjs"]
    }
  ],
  "runtime": {
    "thinking": "high",
    "tools": {
      "enable": ["read", "edit", "bash"],
      "disable": ["eval"]
    },
    "model": {
      "provider": "anthropic",
      "id": "claude-3-7-sonnet"
    }
  },
  "persona": {
    "append": ["Write small, focused diffs.", "Explain WHY in code comments."]
  }
}
```

### Authoring Rules & Strict Validation
- **Pinned Sources:** Package sources must be fully pinned: `npm:<name>@<exact-version>` or `git:<url>@<40-char-sha>`. Floating branches or semver ranges in package sources are strictly rejected.
- **Self Source (`.`):** Allowed only when the declaration is bundled inside a package that resolves to a pinned native source.
- **Resource Selectors:** Paths are package-relative. Symlinks, path traversal (`../`), and absolute paths are strictly refused.
- **Forbidden Fields:** Credentials, secret keys, MCP server definitions, script hooks, and plugin-private configurations are rejected at review time.
- **Layer Folding:** Base → Preset → User Overlay → Session Overlay. Exclusions defeat same-layer inclusions. CLI tool restrictions survive all layers.

---

## 5. Source-Qualified Identity

A preset identity consists of its **canonical source repository plus declared ID**:
```
git:https://github.com/org/repo.git@<commit-sha>#<preset-id>
npm:@scope/package@<version>#<preset-id>
```
- Equal declared IDs from distinct sources (e.g. two separate repositories declaring `id: "coding"`) are **not interchangeable**.
- Short IDs (`coding`) may be used only when unambiguous across all discovered sources.
- When an ID is declared by multiple sources, commands refuse and list all source-qualified candidates.

---

## 6. Review Plans & Inactive Staging

### Review Previews
Running `/wardrobe install <source>` clones or fetches the source, resolves exact commits and package tarballs, verifies integrity hashes (`sha512-...`), and outputs an immutable review plan:
- Lists all installation surfaces and flags those that run install scripts (`installsCode: true`).
- Lists all load surfaces (extensions, skills, prompts, themes).
- Computes a canonical SHA-256 digest over the entire plan.
- **Cancelling review** (or declining approval) leaves staging completely empty and makes zero configuration changes.

### Staging Inactive
Installation requires explicit confirmation with the plan digest:
```sh
/wardrobe install <source> --confirm <64-char-digest>
```
Native packages are installed into an owned staging directory (`<agentDir>/wardrobe/staging/<revision>/attempt-1/`). In staging:
- Resources are filtered inactive: staged `settings.json` has `extensions: []`, `skills: []`, `prompts: []`, `themes: []`.
- Extension code and tools **do not execute** and are not loaded until an explicit process launch.
- `verifiedLaunchable` is recorded as `false` until launch verification.

---

## 7. Isolated Launch & Process Ownership

The standalone launcher starts Pi with `PI_CODING_AGENT_DIR` pointing to the staging directory:
- **No Shared Package Roots:** The child process uses its own isolated package root; personal auth and user files are never copied or linked.
- **Lease Ownership:** Launch acquires an exclusive file lease (`<agentDir>/wardrobe/leases/<revision>.json`).
  - **One Revision, One Writer:** A second attempt to run the same revision concurrently is refused with a competing writer diagnostic.
  - Stale leases (process terminated) are diagnosed and safely replaced; live work is never stolen.
- **RPC Verification:** Before handing over the terminal, RPC preflight verifies that selected resources actually load and identifies any missing dependencies.

---

## 8. Idle Soft Changes vs. Full Switch Launch Plans

Inside a running session, `/wardrobe use <revision>` compares the running revision against the target:
- **Soft Change (In-Place):** If installed packages and selected resources are identical (only tools, thinking level, or persona instructions differ), changes are applied **in-place in the running process** without restarting or changing the PID.
- **Full Switch (New-Process Plan):** If code, packages, or resources differ, the session **refuses to change code in-place**. Instead, it emits a `full-switch` launch plan (`wardrobe run <target>`) and leaves the running process intact.
- **Idle Only:** Applying soft changes during streaming or compaction is refused.

---

## 9. Bindings: Follow vs. Strict Tradeoffs

A binding records what a preset is intended to run:
```sh
/wardrobe bind <preset> --mode follow             # default
/wardrobe bind <preset> --mode strict --revision <id>
```

| Dimension | Follow Mode (`--mode follow`) | Strict Mode (`--mode strict`) |
| --------- | ----------------------------- | ----------------------------- |
| **Selection** | Selects newest approved revision by **approval order** (not semver). | Pins the exact specified revision ID. |
| **Updates** | Automatically adopts newer approved revisions at next launch. | Refuses launch if pinned revision is missing or drifted; never substitutes newer revisions. |
| **Migrations** | Appends migration records to `BindingStore` upon transition. | Records no automatic migrations. |
| **Recovery** | Always runs available approved revision. | Refuses with explicit options: switch to follow, or re-pin a new revision. |
| **Tradeoff** | Smooth continuous adoption; launch target moves forward. | Byte-exact replay and auditability; requires deliberate manual re-pinning. |

---

## 10. Session Resumption & Tree Reconciliation

### Session Resumption
To resume a persisted Pi conversation under a bound preset:
```sh
wardrobe run <preset> --resume <path-to-session.jsonl>
```
The child process restores conversation history, old messages, and skill text while running under the bound revision.

### Session Tree Navigation (`/tree`)
When navigating between conversation branches:
- **Fork Inheritance:** Forking a branch inherits the active binding and soft overrides.
- **Compatible Branches:** Desired soft overrides are reconciled in-place.
- **Incompatible Branches:** If a branch is bound to a different preset, a missing strict revision, or an incompatible runtime, Wardrobe **blocks model turns**. Blocked turns are intercepted immediately without calling the model provider, session history is preserved, and status reports the block with exact relaunch instructions (`wardrobe run <preset> --resume <file>`). Returning to a compatible branch clears the block.

---

## 11. Revision Locks & Drift Detection

Upon successful installation, Wardrobe derives an immutable lock covering:
1. `configuration`: Canonical digest of identity, sources, resource selectors, runtime settings.
2. `resources`: SHA-256 hash of each selected resource file.
3. `code`: Fingerprint of installed package trees under `npm/` and `git/` (excluding `.git` internals and credentials).
4. `baseline`: Pi, Node, npm versions and host platform.

### Drift Diagnosis (`/wardrobe doctor`)
Re-measures disk state against the lock:
- `available`: Matches lock completely.
- `drifted`: Files or code modified on disk. Launch is refused!
- `unverified`: Measured on a different toolchain or host platform.
- `failed`: Install attempt failed and was retained.
- `missing`: Revision directory deleted.

### Rebuild Limits
Locks **do not guarantee unconditional frozen transitive rebuild** across time or external network conditions. Re-installing an edited or drifting revision creates a new attempt directory; it is never quietly re-labeled as the original revision.

---

## 12. Removal, Retention & Baseline Restoration

### Guards Against Accidental Deletion
```sh
/wardrobe retain <preset> --revision <id>    # Pin against deletion
/wardrobe release <preset> --revision <id>   # Drop retain pin
/wardrobe remove <preset> --revision <id>    # Delete single revision
/wardrobe remove <preset>                    # Wholesale remove all revisions of preset
```
- **Active Leases:** An active lease blocks removal.
- **Strict Bindings:** Strict-pinned revisions refuse removal until deliberately rebound (`/wardrobe bind <preset> --mode follow`).
- **Explicit Retains:** A retained revision blocks removal. `/wardrobe release` drops the retain pin without deleting conversation transcripts and without modifying strict mode.
- **Wholesale Refusal:** `/wardrobe remove <preset>` refuses wholesale if any revision of that preset is referenced or hazardous; nothing is partially deleted.
- **Baseline Restoration:** Removing owned revisions deletes staging directories and records while leaving sibling revisions, unrelated files (`auth.json`, `unrelated.txt`), and personal preferences byte-identical.

---

## 13. Shell / PATH Integration & Opt-In Forwarding

Wardrobe provides explicit, reversible integration with the `pi` command:
```sh
wardrobe integrate enable --dir ~/.local/bin
wardrobe integrate disable --dir ~/.local/bin
```
- **Enabling:** Writes an executable `pi` wrapper script into the target directory. The wrapper records the resolved real Pi path at enable time to avoid recursion. It **never overwrites** an existing file.
- **Forwarding:**
  - Ordinary invocations (`pi`, `pi -v`, `pi chat`) forward directly to the recorded real Pi executable, preserving all arguments, cwd, signals, and exit codes.
  - Opted-in `pi --wardrobe` intercepts the command, strips `--wardrobe`, sets `WARDROBE_PI_CLI`, and launches the Wardrobe startup selector.
- **Disabling:** Checks for the `WARDROBE_INTEGRATION_WRAPPER` marker comment. Removes the wrapper only if it bears the marker, refusing to touch any foreign or unrelated file.

---

## 14. Important Boundaries & Limitations

1. **No Sandbox:** Wardrobe relies on Pi's native package manager (Node/npm), which executes package lifecycle scripts. Wardrobe is **not an arbitrary-code sandbox**. Packages run with standard user permissions.
2. **No Automatic Rollback:** Failed package installations are retained for diagnostics (`rolledBack: false`) with residual files listed. Script side effects outside owned staging (global files, external processes) are **not claimed reversed**.
3. **No Detached Process Reclamation:** Detached descendant processes spawned by package scripts are not guaranteed to be killed on failure.
4. **No Unconditional Transitive Rebuild:** Locks do not guarantee identical dependency reconstruction across different networks or registry states.
5. **Platform Limits:** Only **macOS arm64** (`darwin arm64`) on the exact baseline (Pi 1.1.0, Node 26.5.0, npm 11.17.0) is verified. All other platforms and versions are explicitly unverified.
