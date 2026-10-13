# 12: Select startup presets and opt into pi --wardrobe forwarding

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/20
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: run-20261013T073633Z
Branch: ticket/12-startup-selector-forwarder
Blocked by: 09
Verified commit: d9e1055
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/20.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

Bare `wardrobe` opens an interactive pre-Pi selector on a TTY (revision choice,
explicit strict pin or follow, fresh or resume a persisted session) and fails
clearly on a non-TTY, starting nothing. `wardrobe integrate enable --dir <dir>`
writes a marked `pi` wrapper that records the real Pi executable and the agent
directory, refuses to overwrite anything, forwards ordinary invocations
unchanged (argv, cwd, exit code, signals) and routes only a leading
`--wardrobe` to the selector; `disable` removes only a wrapper carrying the
wardrobe marker. New: `selector.mjs`, `integrate.mjs`, and `piCliOf`'s real-Pi
resolution order (env → recorded `pi-cli` → PATH minus wardrobe shims →
argv[1]) which closes a recursion bug where the CLI resolved to itself.
`dispatchPiCommand` in proc.mjs centralizes script-vs-binary spawning.
node-pty is a root devDependency (sanctioned by the public contract as a
reviewed test dependency); packages/wardrobe stays zero-dependency.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` (final tree) | 152 tests, 152 pass, 0 fail, exit 0, ~416 s (138 prior, 14 new) |
| `test/startup-selector-forwarder.test.mjs` alone | 14 tests, 14 pass, 0 fail, ~40 s |
| working-tree review vs baseline `87f4594` | Two passes on both axes, all as parallel reviewer subagents. Pass 1: 12 findings, all fixed. Pass 2: verified all 12 against source; Spec axis clean PASS; 5 Standards residuals, all fixed |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64. node-pty 1.1.0
installed cleanly from the public registry (darwin-arm64 prebuild); no
script(1) substitution was needed.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Standalone wardrobe and opted-in pi --wardrobe display a pre-Pi selector; selection validates mode/revision and invokes the existing launcher, while cancellation starts no preset process | node-pty tests: banner and navigation via arrows and j/k across two presets; confirm reaches `runRevision`; drifted/unavailable revisions refused with an inline diagnostic; `q`/Esc/Ctrl-C cancel with no lease, no binding write, no child, terminal restored; `pi --wardrobe` under node-pty reaches the same selector |
| Ordinary Pi arguments pass unchanged to an explicitly resolved real Pi executable; cwd, exit/signal behavior and --help/--version/noninteractive invocations are preserved without recursion | Wrapper records the resolved real Pi at enable time and never resolves through PATH at run time; PTY test asserts argv/cwd/exit code 42 survive unchanged; `piCliOf` excludes wardrobe shims from PATH resolution; SIGTERM exits 143, not a masked 0 |
| Integration enable/disable is explicit and reversible; no existing Pi binary or unrelated shell config is overwritten automatically | Enable refuses when `<dir>/pi` exists; disable removes only files carrying the wardrobe marker and refuses foreign files; no shell config is written — PATH instructions are printed for the user |
| Real node-pty paths verify selector navigation, cancellation, run/resume mode choice and basic forwarding | 14 tests in test/startup-selector-forwarder.test.mjs, all driven through real node-pty instances or the real wrapper script; run vs resume mode choice passes `--session` to the child; strict pin selection is an explicit `[*] strict` hotkey path that writes the binding |
| Unsupported terminal/runtime conditions fail clearly and leave the baseline usable | Bare `wardrobe` under pipes exits 1 with an actionable message naming `wardrobe run <id>`; nothing started, nothing written |

## Behaviour changes this ticket makes on purpose

- **Bare `wardrobe` now opens the selector** instead of erroring; non-TTY still
  errors, with the non-interactive path named.
- **The launcher resolves the real Pi explicitly** (documented order in
  README); the old argv[1] fallback could resolve to wardrobe itself.
- **The selector can write a strict binding** when the user explicitly pins —
  the same deliberate path as `/wardrobe bind --mode strict`.

## Findings the review forced

Pass 1 (both axes, parallel reviewer subagents), all fixed: piCliOf resolution
order contradicted its own README; exceptions mid-selection stranded the
terminal in raw mode; SIGTERM was masked as a clean cancel; the wrapper's path
interpolation broke on quotes/dollar signs and could not exec a script-only Pi;
the wrapper never propagated WARDROBE_AGENT_DIR; the shim check read whole
binaries; no PTY test exercised navigation, `pi --wardrobe`, or forwarding
under a PTY; duplicated launch tail, quadrupled script-vs-binary dispatch, and
a magic session-index sentinel.

Pass 2 (both axes, parallel reviewer subagents), verified pass 1 against source;
Spec axis passed clean; Standards residuals, all fixed: unused imports, noise
comments, node-pty children orphaned on test failure (now killed via teardown),
a doubled file-head read, and spawnedArgv's layout made uniform across script
and binary dispatch.

## Scope and limits

Remote ticket #20 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

The wrapper is a POSIX shell script verified on macOS arm64 (zsh/bash/dash
semantics in tests); other platforms remain unverified, as the spec allows.
Deliberately deferred: the reference presets (13, 14) and the integrated V1
path (15).
