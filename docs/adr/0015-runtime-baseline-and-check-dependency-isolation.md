# Runtime baseline and check dependency isolation

Status: implemented; native default-model acceptance pending.

## Context

Paid trial 47 exposed three independent problems. Program-owned lineage recovery rewrote `manifest.piVersion` to the old base on every verification, so a candidate tested against the actual Pi 1.3 runtime was repeatedly restored to 1.0.4. Behavior checks then created empty isolated agent directories: the real SoL-Pi package existed in staging, but tests could not resolve it. Finally, the repair template supplied an empty reason, so executing the returned call verbatim was rejected.

Repeated resumes increased cost without resolving these program-owned contradictions. The remaining candidate failures included non-portable Pi module paths and tests that still expected the retired write takeover and preset-pinned reducer route. Those candidate issues must not be hidden by the manager.

## Decision

Treat `manifest.piVersion` as program-owned metadata for the actual current Pi. Restore frozen lineage first, write the current runtime version, and only then capture the candidate digest for runtime loading and final verification. Other lineage fields continue to come from the exact base.

When final verification creates an isolated check agent, link the staged `git` and `npm` dependency directories into it. This lets behavior checks resolve the actual staged artifacts while HOME, sessions and authentication remain isolated. No authentication file is copied, and existing candidate/artifact consistency checks still detect mutation.

Give `verification-repair` a concrete default `adapt` reason so the returned `nextCall` is valid without rewriting an empty field. Keep behavior gates strict and keep candidate compatibility repairs separate from manager fixes.

The paid-trial driver must copy `models.json` and `auth.json` into the temporary agent with mode 0600 rather than symlinking the user's real files.

## Consequences

Public-tool regressions prove that an old runtime baseline advances to the actual Pi, staged packages resolve inside credential-free behavior checks, runtime-loading digest order remains valid, and the returned repair call can be executed directly. Offline trial-47 replay reaches `READY_TO_INSTALL` after the manager fixes and focused candidate repairs: sibling Pi package resolution plus updating two tests to the new edit-fusion and user-route contracts. This does not prove real-model completion or cost improvement; a new paid acceptance run remains necessary.
