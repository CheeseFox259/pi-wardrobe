# Managed Package and Skill Update Assessment

## Scope and Decision

Advance the two managed layers that were behind their upstreams after the Pi 1.1.0 baseline move: six pinned npm packages and the `mattpocock/skills` source with its 30 local overrides. Both lines were authorized by the user in the same maintenance session as the Pi 1.1.0 review. The host runtime was not changed again; Pi stayed at the reviewed 1.1.0 baseline.

## Packages

| Package | Change | Impact on Perfect Pi | Decision |
| --- | --- | --- | --- |
| `@narumitw/pi-lsp` | 0.49.8 -> 0.49.9 | The only source change is a generic `context<T extends ExtensionContext>(ctx: T): T` signature. No runtime behavior, tool or command surface change. | Adopt |
| `@aliou/pi-processes` | 0.12.0 -> 0.13.2 | 0.13.0 persists `context`/`ignore` notifications immediately with `triggerTurn: false`, so a log match appears without waiting for the next user prompt, and never steers or wakes the agent. It requires the Pi extension host that appends custom messages at the turn's tool boundary (pi 0.84.4+); the peer range stays `*`. The `process` tool gains one union `outputSchema`, so codemode callers get structured objects instead of the text preview. 0.13.1 injects `PI_*` session variables into started processes and folds failed/killed counts into the dock summary. 0.13.2 makes log-match rows clickable in fullscreen only. No repository code parses the `process` tool's text output. | Adopt |
| `pi-cc-extensions` | 0.9.5 -> 0.9.12 | 0.9.11 stops breaking on tool renderers without a definition name and preserves wrapped renderer methods, both relevant to Pi 1.1.0's render context. 0.9.12 renames the `inputClip` setting to `toolLabelClip` with automatic migration; Perfect Pi manages neither key and no `inputClip` value exists in the live settings. `cc-dark` and `cc-light` themes are unchanged. | Adopt |
| `pi-web-access` | 0.33.0 -> 0.37.0 | New search providers, real Perplexity snippets, cheaper search, and failed calls now carry `isError: true`. Inside codemode, `web_search` and `fetch_content` return data instead of the formatted text the model sees; the model-facing text is unchanged. Perfect Pi manages only `toolActivation: eager` in `web-search.json`, which the package does not reinterpret, and no repository codemode script consumes these tools. | Adopt |
| `pi-matt-subagent` | 0.5.3 -> 0.9.0 | 0.9.0 promotes the per-run model override to a public call-level `model` field on `subagent` and `research`; the legacy hidden `input` channel still merges. 0.7.0 adds a per-task `thinkingLevel`, resolved per task, then call level, then role default. 0.6.0 adds `/subagents config`. 0.8.0 makes background research children load `npm:@ssk_dev/pi-web-access-lean` and `npm:@upstash/context7-pi` by default, so a research run installs those packages and queries two additional providers. The user accepted that trust-surface change. | Adopt, with a policy hardening below |

### `pi-matt-subagent` verification and hardening

`model` is declared only at call level in 0.9.0; `TaskItem` and `ChainItem` accept `agent`, `task` and `thinkingLevel` but no per-item `model`. A per-task thinking level therefore falls back to the call-level value that `global/extensions/subagent-policy.ts` pins, so the session default still reaches children and no model escapes the allowlist. `parseModel` already accepted the public `model` field, so the 0.9.0 promotion needed no change.

Because "the schema does not allow it" is an upstream accident waiting to happen, the policy now collects models from `tasks[]` and `chain[]` items as well and refuses any that the session has not authorized. With 0.9.0 the extra field never arrives, so the check is inert; if a later version honors a per-task model, the call is blocked instead of silently spending an unauthorized model. Two regressions cover the inert-today case and prove a per-task thinking level cannot change the pinned child model.

## Skills

`mattpocock/skills` moved from `4588b32e` to `f3fc5632` (49 commits, 18 files). 28 overrides sat at `d81f3a18`, one at the old source pin, and one at `c55ee460`.

Each override was reconciled with `git merge-file -p -L local-enhancement -L base -L head <local> <base> <latest>`: 20 merged without conflict and 9 produced conflicts that were resolved by hand. A clean merge is not evidence of preservation, so every upstream-added line between each override's own base and the head was diffed against the local file afterwards. That audit found two deltas a clean merge had silently dropped (`tdd` seam trade-offs and both `teach` changes) and caught the conflicts where the local override had replaced the whole upstream paragraph.

| Override | Adopted | Not adopted, and why |
| --- | --- | --- |
| `ask-matt` | Read a skill's `SKILL.md` before asserting what it does or skipping one of its steps | - |
| `claude-handoff` | - | The upstream change fixes shell quoting for `claude --bg`. The Pi override deliberately runs no Claude process, so the change has no target. |
| `code-review` | Search the repository for every standards document; `AGENTS.md`/`CONTRIBUTING.md` must be on the list | Requiring an issue tracker, the tracker-doc path, and the explicit foreground sub-agent wording are already covered by stricter local rules. |
| `handoff` | Concrete temporary-directory locations (`$TMPDIR`, `/tmp`, `%TEMP%`) | - |
| `implement` | Fetch a passed ticket reference and state its title before starting | The Skill-tool spellings are already Pi-adapted locally. |
| `to-tickets` | Make each ticket a sub-issue when the source was an existing issue | Omitting the "Blocked by" block contradicts the local exact metadata template used for durable ledger files. |
| `wayfinder` | `wayfinder:` labels only, never a triage label; real ids instead of a `#<n>` placeholder; push research branches without opening a PR; resolve by the ticket's type label, not its body | - |
| `grilling` | Word each question so "yes" accepts the recommendation | - |
| `setup-matt-pocock-skills` | Create each configured triage label the tracker lacks; GitHub sub-issue and dependency edges are addressed by database id, not issue number, with the `Part of #<parent>` fallback | The upstream command reference is a longer seed template the local tracker contracts intentionally do not embed. |
| `tdd`, `teach` | Seam catch/miss notes; workspace path resolution; varied quiz answer position | - |
| `resolving-merge-conflicts` | - | Upstream retired the skill (removed in `d81f3a1`). The override is retained, its base stays at the last carrying commit, and the registry already records the retirement. |

After reconciliation, 29 override bases moved to `f3fc5632`; `resolving-merge-conflicts` stays at `c55ee460`. The eight non-overridden required skills were re-installed at the new pin and now match upstream head byte for byte. The one new upstream skill, `chief-of-staff`, is already in `skillPolicy.excludeFromPi`, so it is present on disk and excluded from Pi. `manifest.json` and `components.json` pins moved together and `reconcile.mjs status` reports every source `UP_TO_DATE` with zero overrides pending.

## Incidental Fix

`tmux-tickets.test.mjs` left its git worktree registered after the lifecycle test, so a second consecutive run of the suite failed at `git worktree add` until someone pruned manually. A tmux pane can still hold the worktree as its working directory while the session shuts down, so the cleanup now retries, prunes, and verifies that no worktree entry or branch survives. The suite is repeatable.

## Evidence

**Verified** on the installed Pi 1.1.0 runtime after both lines were synced:

- Installed versions match the pins: `pi-web-access` 0.37.0, `pi-matt-subagent` 0.9.0, `pi-agent-browser-native` 0.9.3, `@narumitw/pi-lsp` 0.49.9, `@aliou/pi-processes` 0.13.2, `@aliou/pi-guardrails` 0.19.0 (already current), `pi-cc-extensions` 0.9.12.
- Every managed package extension loads through the real Pi 1.1.0 extension loader with 0 errors, declaring the expected tools (`subagent`, `research`, `web_search`, `source_check`, `fetch_content`, `get_search_content`, `process`, `lsp_diagnostics`, `lsp_fix`, 8 `agent_browser*` tools) and commands (`subagents`, `ps*`, `lsp`, `context`, `ccstyle`, `guardrails:*`).
- `pi --mode rpc --no-session --offline` starts with empty stderr, emits the LSP status and processes dock widgets, and registers the package commands alongside the managed ones.
- `node doctor.mjs`: `SYNCED`, exit 0, 8/8 packages live with 0 stale managed, 47/47 required skills, SoL-Pi `Pi compatibility VERIFIED`.
- `node scripts/check-pi-compatibility.mjs`: `ok: true`, 25 verified checks, 0 errors.
- `node skill-audit.mjs`: 32 adapted, 10 portable, 4 native, 0 errors.
- `node reconcile.mjs status --json`: all four upstreams `UP_TO_DATE`, pins aligned, 0 overrides with a pending upstream update.
- `node --test *.test.mjs`: 256 tests pass, 0 fail, twice in a row, leaving no worktree or branch behind.
- `~/.pi/agent/settings.json` still holds the user's `perfectPiCompaction`, `defaultProvider`, `defaultModel` and `enabledModels`; `web-search.json` still holds only `toolActivation: eager`.

**Not run**: a live background `research` run, which would install `@ssk_dev/pi-web-access-lean` and `@upstash/context7-pi` and issue real provider queries; the `process` tool's clickable fullscreen log rows; `cc-dark` footer currency rendering; Perplexity snippet quality; the external-PR triage `gh api` path. The SoL-Pi evidence-preserving reducer was not exercised against a real child model.

**Blocked**: None.

**Not applicable**: the Anthropic and Vercel skills sources, already `UP_TO_DATE`, and the two managed MCP servers, already at their latest pinned versions.

## Recovery

`git revert` the two commits in this series, or restore the previous `manifest.json` package pins and skill refs, then run `node setup.mjs` to reinstall. Reverting the package pins re-installs the older packages; reverting the skill refs re-installs the previous upstream content for the eight non-overridden skills while the overrides stay local. A runtime downgrade is separate: pin `manifest.json:piVersion` and reinstall Pi through the official installer, then restart Pi.
