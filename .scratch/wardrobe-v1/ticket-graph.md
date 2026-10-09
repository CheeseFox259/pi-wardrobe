# Wardrobe V1 Implementation Graph

Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8
Acceptance source: remote
Status: approved

## Tickets

| Local | Remote | Behavior | Direct blockers |
|---|---|---|---|
| 01 | [#9](https://github.com/CheeseFox259/pi-wardrobe/issues/9) | V1 prerequisite: prepare local Bare Git and controlled npm fixtures | none |
| 02 | [#10](https://github.com/CheeseFox259/pi-wardrobe/issues/10) | Install the manager and inspect a local preset | none |
| 03 | [#11](https://github.com/CheeseFox259/pi-wardrobe/issues/11) | Discover source presets and approve an immutable review plan | 01, 02 |
| 04 | [#12](https://github.com/CheeseFox259/pi-wardrobe/issues/12) | Review inherited and overridden environments with provenance | 03 |
| 05 | [#13](https://github.com/CheeseFox259/pi-wardrobe/issues/13) | Approve and install a preset with resources inactive | 04 |
| 06 | [#14](https://github.com/CheeseFox259/pi-wardrobe/issues/14) | Verify immutable revisions and diagnose drift | 05 |
| 07 | [#15](https://github.com/CheeseFox259/pi-wardrobe/issues/15) | Launch a verified preset in a real isolated Pi process | 06 |
| 08 | [#16](https://github.com/CheeseFox259/pi-wardrobe/issues/16) | Apply idle session overrides without changing code | 07 |
| 09 | [#17](https://github.com/CheeseFox259/pi-wardrobe/issues/17) | Persist bindings and resume follow or strict sessions | 07 |
| 10 | [#18](https://github.com/CheeseFox259/pi-wardrobe/issues/18) | Reconcile forked and tree-navigated bindings before a turn | 08, 09 |
| 11 | [#19](https://github.com/CheeseFox259/pi-wardrobe/issues/19) | Release references and remove only unreferenced owned revisions | 09 |
| 12 | [#20](https://github.com/CheeseFox259/pi-wardrobe/issues/20) | Select startup presets and opt into pi --wardrobe forwarding | 09 |
| 13 | [#21](https://github.com/CheeseFox259/pi-wardrobe/issues/21) | Deliver an independently installable Minimal Coding preset | 07 |
| 14 | [#22](https://github.com/CheeseFox259/pi-wardrobe/issues/22) | Deliver the optional curated Engineering reference preset | 07 |
| 15 | [#23](https://github.com/CheeseFox259/pi-wardrobe/issues/23) | Exercise and document the complete V1 user path | 10, 11, 12, 13, 14 |

## Initial frontier

- 01: #9, controlled native fixtures.
- 02: #10, manager and local inspection.

All tickets start Execution: open, with no claim or verified commit. Read current ledgers before dispatch. Remote issue bodies and native relationships remain authoritative for acceptance and dependencies. Parent spec was not edited or closed during publication.

## Verification

The graph was checked for missing references, cycles and redundant direct edges before publication. Actual relationship readback and execution-baseline commit are recorded separately; publication is not implementation completion.
