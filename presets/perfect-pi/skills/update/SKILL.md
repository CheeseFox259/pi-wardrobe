---
name: update
description: Integrate upstream preset, skill and installed Pi changes while preserving local adaptations.
disable-model-invocation: true
---

# Update

Call `wardrobe_workflow` action `update` with the selected profile or source and `review: "human"`. Follow its returned `skills.shared` method together with `skills.preset`, loaded from [Perfect Pi design policy](../preset-policy/SKILL.md).

`NO_UPDATE` finishes the check. At `READY_TO_INSTALL`, install with existing authorization.
