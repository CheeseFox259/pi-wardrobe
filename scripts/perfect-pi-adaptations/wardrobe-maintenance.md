# Wardrobe preset maintenance

Pi and extensions, including Wardrobe, use native `pi update`. Wardrobe maintains preset source, skill lineage and compatibility with the installed runtime and extension APIs.

In `/wardrobe`, select this preset → **维护**. Wardrobe prepares a separate writable source directory and dispatches the maintenance task. It contains the complete public preset source, custom skills, companions, registry and current package overrides. The task file names an unchanged base and records the installed revision and original upstream. Resume the same workspace to retain unfinished work.

Run the maintain skill in that source directory. Inspect each upstream and perform actual three-way reconciliation using local content, each override's `baseRef` and the candidate commit. Review every affected companion and license. Retain custom skills, preserved features and Pi-native execution semantics; adopt new Pi capabilities where applicable. Advance override bases and compatibility only after behavior checks. Source-wide pin alignment alone does not prove reconciliation.

This is already a standard standalone preset. Update its `preset.json`, package resource and agent-file declarations, manifest, components registry and tests together. Refresh migration checksums for changed source files while retaining the original provenance. The fixed-source `sync-perfect-pi.mjs` exporter is for rebuilding the initial migration; running it over this maintained source would replace the reviewed local work.

Use isolated HOME and PI_CODING_AGENT_DIR for all tests and setup experiments. Run only the source's discovered checks; model/auth files and project configuration remain native Pi. Installed revisions and private MCP/SoL settings stay outside the maintenance workspace. The original setup scripts are source-maintenance tools and never synchronize the active or global agent directory.

After resolving conflicts and verifying preserved features and native Pi discovery, write the maintenance report. Select **安装维护结果** to review a fixed snapshot and install a new local revision. Custom-skill deletion or disabling and unresolved conflict markers block installation. The running conversation and startup defaults keep their current version until explicitly changed. Updates of locally maintained revisions return to maintenance, preserving the custom source instead of replacing it with upstream files.
