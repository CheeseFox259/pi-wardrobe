# Manage presets from native Pi and hand off executable changes automatically

Users now require preset installation, updates, selection, defaults and adoption of their original configuration through native Pi's composer; this supersedes ADR-0003's external-launcher user flow while preserving its immutable revisions and clean-process boundary. Selecting a preset affects the current session and starts a new conversation; startup defaults are separate, and executable changes use automatic handoff in the same terminal because resource reload cannot reliably clean arbitrary extension state.

Global configuration is adopted independently of project configuration, with global and project startup defaults; models and authentication stay owned by native Pi. Updates prefer complete upstream presets and allow explicit local derivatives for individual package changes, retaining history and compatibility checks rather than mutating the current conversation's environment when a download finishes.


The October 2026 maintenance refinement leaves runtime and extension updates with native `pi update`. Wardrobe maintains preset source and skill lineage in a separate writable workspace, preserving custom skills, companions and per-skill bases. Verified source snapshots become local revisions; updates of those revisions return to reconciliation instead of replacing custom source. The menu uses short action labels and progressive details; the current preset is shown above the composer through Pi's widget API.
