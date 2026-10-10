# Controlled native fixtures

Repeatable, local-only inputs for exercising real Pi installation, staging and
launch behaviour during Wardrobe implementation. Everything here is
self-authored and served over loopback: nothing is published to npm, pushed to
a Git remote, or installed into the caller's live environment.

Tracked by ticket
[#9](https://github.com/CheeseFox259/pi-wardrobe/issues/9) (local ledger
`.scratch/wardrobe-v1/issues/01-local-native-fixtures.md`).

## One command

```sh
npm run fixtures:verify
```

It creates the fixtures, starts the loopback transports, runs every native
check against real Pi processes, removes all owned processes and directories on
success **and** on failure, and writes the merged evidence report to
`.scratch/wardrobe-v1/evidence/native-fixture-report.md`.

`npm test` runs the same suite without regenerating the merged report.

## What it provides

`createFixtureHarness()` returns everything a later ticket needs:

```js
import { createFixtureHarness } from "./fixtures/index.mjs";

const h = await createFixtureHarness({ label: "my-check" });
try {
  await h.pi.runOk("primary", ["install", h.git.sourceFor("v1")]);
  const checkout = h.gitCheckout("primary");
} finally {
  await h.dispose();
}
```

| Member | Purpose |
| --- | --- |
| `git.commits` / `git.sourceFor(rev)` / `git.sourceAt(sha)` | Bare Git source with two immutable full commits, addressable at `git:http://127.0.0.1:<port>/git/wardrobe-git-fixture.git@<sha>` |
| `npm.sourceAt(version)` / `npm.entry(version)` | Controlled registry sources with real tarball integrity and install-script metadata |
| `pi.run` / `pi.runOk` / `pi.rpc` | Real Pi CLI invocations and offline NDJSON RPC sessions |
| `markerEvents()` / `extensionEvents()` | Dependency install-script and extension lifecycle evidence |
| `settings` / `settingsBytes` / `snapshotAgent` / `gitCheckout` | State inspection that distinguishes unchanged settings from residual installed files |
| `baseline`, `primary`, `second` | Seeded agent directories holding original preferences and unrelated sentinels |

Agent directories are seeded with `ORIGINAL_PREFERENCES` and two files no
fixture owns (`auth.json` as a placeholder, `unrelated.txt`). Any change to
those is a fixture bug.

## Isolation guarantees

- One temporary root per harness holds HOME, agent directories, sessions, npm
  config and cache, Git config, the served web root and all marker logs.
- Child processes receive a fixed environment allowlist, so no personal
  credential, proxy or auth-store setting reaches Pi, npm or Git.
- `dispose()` closes the loopback server, SIGKILLs every tracked child, removes
  the temporary root and writes evidence. It is idempotent, and an exit safety
  net covers a process that dies before `dispose()`.
- npm config files are written with `ignore-scripts=false`. That is the
  observed configuration for these checks on npm 11.x, not a claim about every
  user policy.

## Checks covered

| File | Covers |
| --- | --- |
| `test/git-lifecycle.test.mjs` | Both commits addressable at a full SHA, real clone, dependency-script marker, persistent same-repository ref collision, missing-ref refusal, owned removal |
| `test/npm-lifecycle.test.mjs` | Exact-version resolution, install-script execution, unfiltered declaration, installed-inactive filtering, failing install with retained external marker, explicit repair, owned removal preserving preferences and sentinels |
| `test/agent-isolation.test.mjs` | Two agent directories holding two commits of one source concurrently, directory-scoped removal, preferences preserved |
| `test/rpc-observation.test.mjs` | Command, tool and event registration in a live offline process; reload shutdown; per-process state reset; declaration-governed activation |
| `test/cleanup.test.mjs` | Resource reclamation after a failure, idempotent dispose, failure recorded in evidence without leaking temporary paths |

## Findings that later tickets depend on

- An **unfiltered** install loads its extension when a process starts. Keeping
  a package inactive requires declaring explicit empty resource filters, and
  those filters survive native install unchanged.
- A failed install is refused, but it is not transactional: settings are
  untouched while the installed directory and the failing script's external
  marker remain.
- Two agent directories hold two commits of one Git source concurrently; the
  persistent checkout path is per agent directory.

## Not claimed

The generated report repeats these, and they are load-bearing:

- The loopback transport does not validate live GitHub or any public source.
- No package was published to npm or pushed to a Git remote.
- Native install is not an arbitrary-code sandbox.
- Failed installation is not rolled back; residual files and script effects
  remain.
- Detached descendants of fixture scripts are not guaranteed to be reclaimed.
- Only the recorded Node/npm/Pi versions on the recorded platform were
  exercised.
- This evidence covers fixture transport only, not the Wardrobe product.

## Layout

```
fixtures/
  index.mjs          public entry point
  harness.mjs        orchestration, evidence, cleanup
  report.mjs         merge per-check evidence into one report
  lib/               sandbox, transports, sources, Pi runner, evidence
test/                node:test checks; support/ holds shared setup
```

To point the checks at an uninstalled Pi checkout, set
`WARDROBE_FIXTURE_PI_ROOT`; otherwise the managed release under
`~/.pi/agent/install` is used.
