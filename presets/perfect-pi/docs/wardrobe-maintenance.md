# Preset update and maintain

`update` follows upstream changes. `maintain` fixes a user's specified bug or adds a requested capability without checking unrelated updates.

In `/wardrobe`, manage a preset → **更新** or **维护**. Both command paths and the `wardrobe_workflow` tool use the same candidate/verify/install operations. Models and authentication remain native Pi; Pi and extension program updates use `pi update`.

Update checks exact upstream targets and reuses a shared Git cache. The last successfully integrated upstream version becomes the next base. The local `base/` directory is only the starting local snapshot. No upstream change returns `NO_UPDATE` without invoking a model. Changed inputs produce a compact structured handoff: safely applied paths, local conflicts, new capability candidates, native Pi/API information and the exact inputs available on disk. The model judges value and adoption/adaptation; it does not redo the inventory.

Source edits happen in a candidate, never an installed revision. Keep custom skills, local features and device bindings. Deleted or moved upstream content requires a decision. Defer retains the older real base and records the reviewed target so unchanged deferred deltas do not recur.

The model writes result.json and selects 1–5 affected checks with reasons. `wardrobe_workflow verify` records actual command results and source hashes; `install` rejects missing/stale evidence and unresolved conflict markers or missing custom skills. Full suites are not the default. Install creates a new inactive revision; session use and startup defaults remain explicit choices. Test artifacts and private config are not preset source.
