# Focused verification repair and fresh package metadata

Status: implemented; native default-model acceptance pending.

## Context

Paid trial 44 reached all 22 decisions and 33 candidate changes, but failed before installation. The first verification used a stale npm packument under `prefer-offline` and reported `ETARGET` for an exact published package. After the model refreshed registry metadata manually, later verification reported six failures. Every work item was marked decided, so the handoff still offered final `verify` without a focused repair path. The model investigated the failures but made no further candidate edits before the unfocused watchdog stopped.

The failures themselves are not interchangeable. Registry metadata freshness is manager-owned. Candidate behavior, broken assertions, non-portable absolute test paths and incorrect module-location assumptions require candidate repair and must never be hidden by the manager.

## Decision

Package staging uses `prefer-online` so exact artifacts revalidate registry metadata while retaining npm's artifact cache and Pi's installation ownership.

A failed change-list verification creates or reopens a `verification-repair` work item with the failed checks, original logs and affected test paths. It becomes the current focus with a required durable repair decision. The model edits the candidate, saves that decision and returns to final verification. A later failure reopens the same item instead of leaving it decided. Fresh failures and cached identical failures share this handoff, so older records cannot bypass repair. Failure status, checks and installation gating remain intact; no check is skipped or converted into a pass.

## Consequences

Public-tool regression covers an initial failed behavior check, a second failed attempt that reopens repair, a real candidate edit, and successful final verification. A separate install regression proves the exact staging environment requests fresh registry metadata. These deterministic results do not prove that trial 44's candidate fixes are correct or that a real model will complete them at an acceptable cost.
