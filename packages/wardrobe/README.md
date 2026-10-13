# @pi-wardrobe/manager

The Wardrobe preset manager for Pi. It registers exactly one command,
`/wardrobe`, and nothing else. It also ships a standalone `wardrobe` launcher,
which starts a verified revision in a new process and nothing in this one.

## Command surface

| Command | Behaviour |
| --- | --- |
| `/wardrobe list` | Discovers `preset.json` declarations in the configured source directories, validates each strictly, and lists them with their snapshot state. Read-only: it never copies resources |
| `/wardrobe show <preset>` | One preset's identity, version, source, composed layers, packages and selected resources. Captures a snapshot as it inspects |
| `/wardrobe explain <preset>` | Every composed value with the layer and revision it came from, the resources that load and the ones that do not with their reasons, and the preferences that are only proposals |
| `/wardrobe explain <preset> --overlay <path>` | Composes one session overlay over the preset. Soft preferences only |
| `/wardrobe explain <preset> --disable-tool <a,b>` | Applies a CLI exclusion: no layer can re-enable those tools, and the request is reported as unmet |
| `/wardrobe explain <preset> --model <provider/id>` | Records an explicit model choice, which wins over any declared preference |
| `/wardrobe install <source>` | Discovers the source and produces an immutable review plan. Installs nothing |
| `/wardrobe install <source> --preset <path>` | Explicit selection when a source declares more than one preset |
| `/wardrobe install <source> --confirm <digest>` | Approves the plan by quoting the digest it printed, then installs it into owned staging with every resource filtered inactive, and measures its lock. A different digest is refused and installs nothing |
| `/wardrobe status [revision]` | Every installed revision, one line each: the state the install recorded beside the state measured now. No selector means the whole store |
| `/wardrobe doctor [revision]` | The full diagnosis per revision: configuration, selected-resource content, installed code, baseline and declared runtime data, with every difference named |
| `/wardrobe bind [preset] [--mode follow\|strict] [--revision <id>]` | Records what a preset is meant to run, and with no preset named, reports every binding, its mode and its migration history. Follow is the default; strict refuses to be recorded without a revision to pin |
| `/wardrobe use <revision>` | Changes the running session when only preferences differ — tools, model preference, thinking level, appended instructions — and reports what is in effect beside what was intended. When packages, resources or code differ it returns the **new-process launch plan** instead, starts nothing, and is refused while the revision is busy |
| `/wardrobe remove <preset> [--revision <id>]` | Deletes unreferenced owned revisions. With `--revision` deletes only that unreferenced revision; without `--revision` deletes all unreferenced revisions of the preset, refusing wholesale if any relevant revision is referenced or hazardous |
| `/wardrobe release <preset> --revision <id>` | Drops an explicit retention reference without deleting conversation history or altering strict bindings |
| `/wardrobe retain [preset] [--revision <id>]` | Explicitly retains a revision against removal, and with no arguments, lists all explicit retain references |

`list`, `show`, `explain`, `status` and `remove` also report installed revisions, so the
declared shape of a preset and the state of any revision built from it are
never merged into one claim. `show` and `explain` match on the source-qualified
identity of the declaration they were asked about: a local declaration that
shares an id with an installed revision reports no revision of its own rather
than borrowing another source's state.

`status`, `doctor`, `use`, `remove`, `release` and `retain` address a revision by its revision id, its
source-qualified identity (`git:…@<sha>#<id>`), or its preset name. An
ambiguous name is refused with the ids that do exist rather than resolved to a
guess.

## Composition and provenance

A declaration is rarely the whole environment. Composition folds layers in one
order — **Base → Preset → User → Session** — and every effective value keeps the
layer it came from, so `explain` reports provenance instead of a merged blob.

- **Parents** resolve from their own pinned source: the parent is captured, not
  trusted, so an inherited declaration is read at a full commit or an exact npm
  version like any other. A parent that declares several presets must be named
  with `presetPath`, and a chain that repeats an identity is refused with the
  whole chain rather than resolved arbitrarily.
- **Aliases are stable.** An inherited alias cannot be rebound to another
  package, and two layers that require different versions of one canonical
  package fail with both origins instead of a winner being picked.
- **Resource selectors** fold per package and kind. A supplied `include`
  replaces the candidate set and re-includes the paths it names; an omitted
  `include` inherits. A supplied
  `exclude` removes paths afterwards, so a same-layer exclusion wins over a
  same-layer inclusion. A lower exclusion survives until a higher layer names
  that path again. `include: []` chooses none, and a package and kind with no
  selector anywhere loads nothing.
- **Tools** fold the same way: same-layer disable wins, a higher layer may
  re-enable, and nothing re-enables a tool the user or the CLI excluded. An
  unmet request keeps its reason.
- **Instructions** append in layer order; nothing is removed or replaced. A
  **model preference** yields to an explicit user or CLI choice, which is
  reported as such rather than as an effective value.
- **Overlays are soft.** A user overlay (`<agentDir>/wardrobe/user.json`) or a
  session overlay may set tools, thinking, model and appended instructions, and
  nothing else. Declaring a package or a resource is refused: loaded resources
  belong to a reviewed revision, and changing them requires a new one.

Only executable identity — the packages and the resources that would load —
decides whether a change needs a new reviewed revision. Preferences do not
appear in it, so a soft change is classified as one.

## Installing an approved plan

`--confirm <digest>` is the only path that installs anything. It re-checks that
the plan still hashes to the digest that was approved, re-verifies each named
artifact against the registry, and then installs through Pi's own package
manager into `<agentDir>/wardrobe/staging/<revision>/attempt-<n>/` — a fresh
agent directory this manager owns, with no auth, no user files and no shared
package roots.

- **Nothing loads.** The staged `settings.json` declares every package with
  each resource type filtered to `[]`, before the install runs and again after
  it. A staged revision can be inspected, and a process can start against it,
  without a single resource becoming active. Activation is a separate, explicit
  step this manager does not take.
- **A revision is not reinstalled in place.** An available revision for the
  same plan is reported as already available. A different resolution of the same
  preset is a different revision and is staged beside the first one.
- **A failure stays visible.** Pi's install runs package scripts, so a failed
  attempt is retained as explicitly failed/unavailable with its residual files
  listed and `rolledBack: false`. A retry is a new attempt directory; the
  earlier one is reported as retained, never described as undone.
- **The inventory is not launch availability.** A staged revision reports
  `verifiedLaunchable: false`; whether a real process can start against it is
  verified later.
- A `.` self source installs as the pinned native source of the package that
  ships the declaration. A local snapshot with no pinned native source is
  refused, because Pi does not install a local package's dependencies and the
  approved artifacts would otherwise not be what is installed.

## Changing a running session

`/wardrobe use` has two jobs and never blurs them. A difference in tools, model
preference, thinking level or appended instructions is a preference the running
process can adopt. A difference in packages, resources or code is not: those were
reviewed and installed as a revision, and changing them is a new process.

- **The decision is made from the installed tree, not from the declarations.**
  Installed code is compared per package, because a tree digest covers the
  installer metadata beside the packages and npm's lockfile records the directory
  it was installed into — two installations of identical content carry
  different digests. The question a running process asks is whether this is the
  same code, not whether these are the same bytes.
- **Nothing is applied mid-turn.** A session that is streaming or compacting is
  refused, with the reason, and nothing changes. Refusing beats half-applying a
  preference while a run is in flight.
- **What is intended and what is in effect are reported separately**, per field,
  with a status of `in-effect`, `different` or `partly-applied`. A value the
  runtime clamped, a tool nothing provides, and a model preference with no
  credentials here are all reported as what they are — never as applied.
- **The revision is not touched.** Applying a preference writes nothing: the
  process, the PID, the revision directory, its settings and its lock are
  unchanged, and a change this session cannot adopt returns a launch plan rather
  than a partial edit.
- **What a session has adopted lives in the session's own entries**, so it
  follows the active branch: a fork inherits it and an abandoned branch does not
  contribute to the branch the user is on. Instructions are contributed as prompt
  guidelines rather than as a replaced prompt.

The launcher points the started process at both directories it needs:
`PI_CODING_AGENT_DIR` is the revision's own, and `WARDROBE_AGENT_DIR` is the
manager's, so `/wardrobe` inside a launched revision finds the revisions rather
than looking inside itself. The launcher also loads its own extension into the
process it starts, because a revision with no `/wardrobe` could be neither
inspected nor reconfigured.

## Bindings, follow and strict

A binding is a durable statement of intent — follow by default, strict when a
user pins a revision — kept beside the revisions it names. It is not a lease, a
lock or a session: it says what should be true when a session starts, and a
later resume checks the world against it.

```sh
/wardrobe bind <preset> --mode follow              # or simply: /wardrobe bind <preset>
/wardrobe bind <preset> --mode strict --revision <id>
/wardrobe bind                                         # what is bound, and how it got there
```

- **A preset is its repository, not its pin.** A binding is keyed by the
  canonical source repository plus the declared id, so two revisions of one
  preset are two revisions of *one* preset and a follow binding can see its own
  siblings. The commit or version is what a revision adds.
- **Follow follows approval order, not a version label.** It takes the newest
  approved, available revision of that preset. A preset may publish 2.0.0 after
  1.1.0 was approved, and the newest *approved* revision is the one reviewed
  last. No network lookup and no semver comparison is involved.
- **Strict never substitutes.** A pinned revision that is missing or drifting
  refuses, naming the way out — switch to follow, or install and pin another
  revision deliberately. It never quietly runs something newer.
- **Migrations are recorded, not guessed.** Each launch writes what it moved
  between and why, append-only; the first launch of a binding counts as a move
  from nothing. Old revisions are left intact and old conversations are not
  rewritten: resuming appends to the session file, and the earlier history is an
  unchanged prefix of it.
- **A binding is a file; a session preference is not.** What is transient is a
  session's soft overrides, because a custom entry alone does not flush a
  conversation. Startup coordination is a separate, per-process launch record, so
  nothing claims a conversation is durably bound to a revision.

`wardrobe run --resume <path>` continues a conversation Pi already persisted. The
path must exist: a session is written by the process that wrote it, so resuming
one that was never written is refused rather than pointed at nothing.

`status` and `doctor` report bindings, their migrations and the launch records
beside the revisions they govern.

## Branch navigation and reconciliation

Navigating between branches in a running session (`/tree` or Pi's session tree
navigation) moves the active conversation across branches that may carry
different soft overrides or binding targets.

Wardrobe reconciles the destination branch with the running process runtime:

- **Soft overrides are restored in place.** If the target branch is on the same
  revision, desired soft overrides (tools, model, thinking level, persona
  instructions) are planned and applied in-place without restarting the process.
- **Follow branches keep the running newer approved revision.** When navigating
  to an older branch of the same preset under follow mode, the process remains on
  its current newer approved revision and appends durable migration evidence to
  the binding record (`BindingStore`) and the session branch, rather than chasing
  an older or newly installed revision mid-session.
- **Incompatible branches block model turns.** When navigating to a branch bound
  to a different preset, a branch with a strict revision mismatch, a branch
  requiring a newer revision than what is currently running, or a revision with
  unmet requirements, Wardrobe intercepts and blocks subsequent model turns.
  Blocked prompts are handled immediately without invoking the model provider,
  leaving session history unchanged. The refusal notifies the user and provides
  the exact relaunch plan:
  ```sh
  wardrobe run <preset> --resume <session-file>
  ```
  Navigating back to a compatible branch clears the block and unblocks model
  turns immediately.
- **Observability throughout navigation.** `/wardrobe status` displays the
  active process PID, running code state (revision and preset), user
  restrictions, and any active turn block with its relaunch plan.

## Launching a revision and startup selector

The standalone `wardrobe` command starts a verified revision or opens an
interactive startup selector. It lives in `packages/wardrobe/bin/wardrobe.mjs` and
is exposed as the package's `bin`.

```sh
wardrobe                             # open interactive startup selector (TTY)
wardrobe run <revision> [args…]      # start it directly; everything after -- is Pi's
wardrobe use <revision>              # print the launch plan and start nothing
wardrobe integrate enable --dir <dir>  # create a pi forwarding wrapper in <dir>
wardrobe integrate disable --dir <dir> # remove the wardrobe pi wrapper from <dir>
```

### Interactive startup selector

Running bare `wardrobe` in an interactive terminal (TTY) displays the pre-Pi
startup selector before any Pi process starts:

- **Revision selection:** lists all installed presets and revisions measured
  by `diagnoseAll`, showing availability status and any active notices.
- **Mode choice:** toggles between `follow` (run newest approved revision and
  record migrations) and `strict` (explicitly pins the chosen revision in
  `BindingStore`).
- **Session choice:** offers `Fresh session` or lists persisted sessions found
  under `<revisionDir>/wardrobe/sessions/`. Choosing a persisted session passes
  `--session <path>` to Pi.
- **Validation:** unavailable or drifted revisions cannot be launched; selecting
  one displays a clear refusal reason without spawning a child process.
- **Controls:** Arrow keys navigate revisions and sessions, `Tab`/`m` toggles
  mode, `Enter` validates and launches the selected revision, and `Esc`/`q`/`Ctrl-C`
  cancels cleanly (exiting 0, acquiring no lease, and spawning no child process).
- **Non-TTY failure:** invoking bare `wardrobe` in a non-interactive stream (pipes
  or redirects) fails with exit code 1 and an actionable message directing the
  caller to non-interactive `wardrobe run <revision>`.

### Shell/PATH integration and forwarding

`wardrobe integrate` provides optional, explicit, and reversible integration
with the `pi` command:

- `wardrobe integrate enable --dir <dir>` writes a thin executable wrapper script
  named `pi` into `<dir>`.
  - It resolves the absolute path to the real Pi binary and records it literally
    inside the wrapper at enable time.
  - It **never overwrites** an existing file: if `<dir>/pi` already exists, enable
    refuses without modifying the file.
  - It leaves unrelated shell profiles intact and prints the command needed to
    prepend `<dir>` to `PATH`.
- `wardrobe integrate disable --dir <dir>` removes `<dir>/pi` only if it contains
  wardrobe's integration marker comment. Any foreign or unrelated file is refused.
- **Wrapper forwarding semantics:**
  - Ordinary Pi invocations (`pi`, `pi chat`, `pi --version`, `pi --help`, etc.)
    forward directly to the recorded real Pi executable, preserving all arguments,
    flags, working directory, exit status, and signal disposition.
  - Opted-in `pi --wardrobe` strips the `--wardrobe` flag, sets `WARDROBE_PI_CLI`
    to the recorded real Pi path, and execs the Wardrobe startup selector.
  - **No recursion:** because the wrapper records the resolved real Pi path
    literally, it never resolves through PATH at run time in a way that can hit
    itself.

### Real Pi resolution order

When resolving the real Pi executable to launch or record:

1. `WARDROBE_PI_CLI` environment variable (explicit override)
2. Recorded path under `<agentDir>/wardrobe/pi-cli`
3. PATH resolution for `pi`, strictly skipping wardrobe's own shims, wrappers,
   and launcher script
4. `process.argv[1]` when invoked inside a real Pi session as an extension
   (excluding wardrobe's own CLI)

The manager's own directory is named with `--agent-dir` or `WARDROBE_AGENT_DIR`,
and `PI_CODING_AGENT_DIR` is deliberately not accepted: Pi exports it to every
process it starts, so honouring it would mean launching into a caller's own
environment whenever the launcher was run from inside a session. Without an
explicit directory the launcher refuses.

From inside a Pi session, `wardrobe use` is the command to run: it starts
nothing, so it cannot embed another TUI. `wardrobe run` starts a real
interactive process and belongs in a terminal of its own.

- **The launch is isolated.** Pi is started with `PI_CODING_AGENT_DIR` set to
  the revision's own directory, never the user's, and always with an explicit
  session directory — the revision's own unless `--session <path>` names
  another. Nothing is copied or symlinked out of the user's directory: a
  revision has no credential of yours in it, and `pi` creates its own empty
  store there as it would anywhere else.
- **Selection is the only thing that is written.** Launching rewrites the
  revision's `settings.json` so exactly the approved resources load, using Pi's
  own package filters and `defaultTools`. That file is outside the locked code
  roots, so activating a revision never invalidates its lock. A refused or
  failed launch puts the file back as it was.
- **Nothing is hidden.** Before the user's terminal is handed over, the
  launcher starts a real Pi against the activated revision in RPC mode and asks
  what it loaded. A selected skill or prompt that registered nothing, a command
  registered by two different resources, and tool requirements that could not
  be confirmed are all reported. Resources Pi discovers outside the revision —
  `~/.agents/skills`, a project's `.agents/skills` — are named too, because a
  launch that quietly inherited part of someone else's environment would be
  hiding the one thing it exists to make visible.
- **One revision, one writer.** A run takes a lease on the revision before
  anything is written and releases it when Pi exits, however it exits. A second
  run of the same revision is refused and names the holder; a different
  revision runs at the same time. A lease whose process is gone is reported as
  stale and replaced; a live one is never taken.
- **The child's lifecycle is the launcher's.** The working directory, the
  arguments after `--`, SIGINT and SIGTERM, and the exit status all belong to
  the Pi process, and the launcher reports them in a run record under
  `<agentDir>/wardrobe/runs/`.

A revision that no longer measures as its own lock is not launched at all: the
refusal names the drift, and the revision is left exactly as it was.

## Revision locks and drift

An installed revision is measured, not trusted. Immediately after installation
the manager derives a lock from the files that are actually on disk, and an
install is only reported `available` when that measurement is complete.

| Part of the lock | What it covers |
| --- | --- |
| `configuration` | A canonical digest of the approved effective configuration: identity, exact sources, resource selection, runtime and persona. No timestamps, no machine paths, no secrets |
| `resources` | One SHA-256 per selected resource file, resolved through Pi's own inventory |
| `code` | A fingerprint of every installed package tree under `npm/` and `git/`, plus a digest per package and per installer-metadata root |
| `baseline` | The Pi, Node, npm and platform the revision was measured on. An unidentified Pi build or an unreadable npm version is a measurement problem, so the install is not reported available |
| `runtimeData` | The declared mutable roots (`sessions/`, `wardrobe/`). Listed, never hashed, and always outside the locked code roots |

Fingerprints deliberately omit Git's own directories — they move on their own
and say nothing about installed code — and credential files, which are not code
and must never reach a reported fingerprint. A directory that is never read is
reported as skipped rather than silently dropped.

`/wardrobe doctor` re-measures and reports one of five states, none of which is
a softer version of "fine":

| State | Meaning |
| --- | --- |
| `available` | Every measurement still matches the lock |
| `drifted` | Measured, and no longer matching. Refused |
| `unverified` | This host cannot vouch for it: a different toolchain or platform, an unsupported declared range, or a measurement that could not be completed |
| `failed` | The install attempt failed and was retained as failed, with its residual files |
| `missing` | The revision's directory is gone |

Re-running an approved install re-measures the revision it would reuse. One
that still matches its lock is handed back untouched; one that has drifted is
replaced by a fresh attempt in a new directory, and the record says which
attempt it replaced and why. The drifted directory is left exactly as it was.

A drifted or missing revision is never quietly re-labelled as the approved one.
There is no path that rebuilds the tree and calls the result the same revision:
a different tree is a different tree, and adopting it means approving a new
plan. A record whose directory has disappeared is installed again into a new
attempt rather than handed back as the revision it no longer is.

A declaration's `compatibility.pi` range and its optional `platforms` list are
checked against the observed baseline. A range that cannot be resolved and a
Pi build that cannot be identified are both reported as unanswerable, never as
satisfied.

Intended configuration and observed state are always reported side by side, so
a record that still says `available` after the installed tree changed appears
as exactly that. The state is the whole claim — there is no separate health
boolean to soften it. `launchable` is reported as `false` throughout: whether a
process can start against a revision is a separate, verified step.

## Discovery and the review plan

`/wardrobe install` captures a source and describes it. Only an explicitly
approved plan is installed.

- **Git** sources are fetched with real Git at a full 40-character commit SHA.
  A branch or tag is refused: a plan is only immutable when it names what it
  read. Capture is repeatable — the same source can be reviewed again.
- **npm** sources resolve an exact version, read the registry packument, verify
  the tarball against its own integrity hash, and extract it. No install runs
  and no lifecycle script executes.
- **GitHub** references (`owner/repo`, `github.com/…`, `https://…`, `git@…`, with
  or without `.git`) normalize to `github:<owner>/<repo>`. A preset path is
  written `#presets/<name>`, not as a tree URL, because a ref may contain
  slashes.

The plan names every installation surface with its exact artifact and integrity,
every resource selector, every load surface, and a digest over all of it.
`--confirm` is valid only for that digest; if the source or its artifacts
change, the recomputed digest differs and the approval is refused. There is no
flag that approves without showing a digest.

Resources of a **self source** (`.`) are the ones shipped alongside the
declaration, so their paths are resolved during review: absolute paths,
traversal, missing files and symlinks are refused before any plan is sealed.
Resources of external packages cannot be resolved until that package is
installed, and are checked there.

`$WARDROBE_REGISTRY` selects the registry Wardrobe reads. Wardrobe reads only a
registry it was pointed at explicitly.

A preset id on its own resolves only when it is unique. Two sources declaring
the same id make the short form ambiguous, and `/wardrobe show <id>` refuses
with both candidates rather than guessing.

## What this package deliberately does not do

- No dependencies, no install scripts, no MCP servers, no browser tooling, no
  skills, prompts or themes. Installing the manager must not pull in a preset.
- No credentials. A preset cannot declare one, and the manager never reads or
  writes the user's auth store.
- No claim of activation. `list`, `show` and `explain` report
  `installed: false, active: false`; `install` reports a staged revision whose
  resources are filtered inactive, explicitly not verified launchable.
- Declared `runtime.model`, `runtime.thinking` and `runtime.tools` are reported
  as proposals until a preset is applied.
- No rollback. A failed install leaves its files and its package script effects
  in place and reports them; a retry is a new attempt beside it.

## Declaration contract

A preset definition is a `preset.json` with `schemaVersion: 1`. Required:
`schemaVersion`, `id`, `name`, `version`, `compatibility.pi`. Optional:
`description`, `author`, `compatibility.platforms`, `extends`, `packages`,
`resources`, `runtime`, `persona`.

A preset `id` may be namespaced, e.g. `wardrobe/minimal-coding`. A package
source is `npm:<name>@<exact-version>`, `git:<url>@<full-commit-sha>`, or `.`
for the package that contains the definition itself. A branch or tag is
refused: a preset always pins what it resolved to. `extends` names one parent,
`{ source, presetPath? }`, captured from its own pinned source.

Each entry in `resources` selects paths *inside* a declared package:
`package` names an alias from `packages` — its own or an inherited one —
`kind` is `extensions`, `skills`, `prompts` or `themes`, and both `include` and
`exclude` are optional package-relative path lists such as
`skills/review/SKILL.md`. An empty `include` is valid and means "load none of
this"; an omitted one inherits the lower layer's selection. Omitting `kind`
applies the selector to the package as a whole; the exact type a path loads as
is Pi's own per-type filtering, so the plan does not guess one.

Validation is strict. Unknown fields, malformed versions or ranges, and
excluded concepts — credentials, MCP server definitions, script hooks, plugin
private configuration — are refused with the exact path that caused them. An
alias a resource names but no layer declares is refused when the layers are
composed, which is the first point where the whole chain is known.

```json
{
  "schemaVersion": 1,
  "id": "minimal-coding",
  "name": "Minimal Coding",
  "version": "1.0.0",
  "compatibility": { "pi": ">=1.1.0 <2.0.0" },
  "runtime": { "thinking": "medium" },
  "persona": { "append": ["Prefer small diffs."] }
}
```

## Where presets are read from

`$WARDROBE_PRESET_DIRS` (comma-separated absolute paths), otherwise
`<agentDir>/presets`. Declarations are found at a source root or one level
below it.

Snapshots this manager writes live under `<agentDir>/wardrobe/snapshots/` and
capture the declaration. Resource paths are not materialised there: they are
package-relative, so they can only be resolved once the declared package is
installed. Installed revisions and their records live under
`<agentDir>/wardrobe/staging/`.

## Revision removal and retained references

`/wardrobe remove` and `/wardrobe release` manage the lifecycle of installed
revisions. Deletion is guarded, un-automated, and confined strictly to the
manager's owned staging storage.

```sh
/wardrobe retain <preset> --revision <id>   # explicitly retain a revision against deletion
/wardrobe retain                            # list all explicit retain references
/wardrobe release <preset> --revision <id>  # drop an explicit retention reference
/wardrobe remove <preset> --revision <id>   # delete a single unreferenced owned revision
/wardrobe remove <preset>                   # delete all unreferenced revisions of a preset
```

- **References block removal.** A revision cannot be removed while it has an
  active lease, is running in the current session, is pinned by a strict binding,
  or is explicitly retained. Follow history (migrations, past launches) does
  not pin old revisions forever.
- **Strict bindings must be deliberately changed.** Removing a strict-pinned
  revision is refused and names the way out (`/wardrobe bind <preset> --mode follow`).
  Removal never silently alters or bypasses strict mode.
- **Releasing drops explicit retention without collateral damage.**
  `/wardrobe release` drops the retention pin without deleting conversation
  transcripts and without changing strict mode. If a strict binding still pins the
  revision, removal remains blocked until deliberately rebound.
- **Wholesale refusal without `--revision`.** `/wardrobe remove <preset>` evaluates
  every installed revision of the preset. If any revision is referenced or has a
  safety hazard, the entire operation is refused wholesale and nothing is partially
  deleted.
- **Safety confinement.** Removal verifies that target directories are strictly
  inside `<agentDir>/wardrobe/staging/`. Escaping symlinks, missing paths, stale
  leases, and ambiguous ownership are diagnosed and refused. Package cleanup
  operates only inside the owned revision root; sibling revisions and the user's
  personal environment remain intact, and install-script external effects are
  reported as not claimed reversed.

## Checks

```sh
npm test
```

- `test/schema-strict.test.mjs` — declaration and overlay validation
- `test/manager-inspection.test.mjs` — the manager installed and driven inside a
  real isolated Pi session
- `test/composition-provenance.test.mjs` — layer folding, and inherited presets
  reviewed through real Git and npm sources
- `test/staged-inactive-install.test.mjs` — approving a plan and installing it
  through Pi into owned staging, with every resource inactive
- `test/revision-lock-doctor.test.mjs` — measuring installed revisions, the
  exclusions a fingerprint makes, and drift, baseline, compatibility and
  missing-revision diagnoses
- `test/isolated-pi-launch.test.mjs` — starting a revision through the
  standalone launcher: what loaded, what was isolated, who held the lease, and
  what the child process did
- `test/idle-session-overrides.test.mjs` — applying preferences inside a running
  session and reading back what it is actually using, including what a local
  model provider was asked
- `test/bindings-resume.test.mjs` — binding a preset, following approval order,
  refusing a strict mismatch, and persisting a conversation in one process and
  resuming it in another
- `test/startup-selector-forwarder.test.mjs` — interactive standalone selector,
  strict/follow modes, session resume, non-TTY failure, shell/PATH integration,
  recursion avoidance, and real node-pty acceptance

Tracked by
[issue #15](https://github.com/CheeseFox259/pi-wardrobe/issues/15).
