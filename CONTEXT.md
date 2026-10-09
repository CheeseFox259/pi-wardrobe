# Pi Wardrobe

Shared language for Pi working-environment presets and their supplied resources.

## Language

**Preset**:
A named working-environment configuration combining resources and preferences. A preset is distinct from the packages supplying its resources and from any particular installed revision.
_Avoid_: package, agent directory

**Package**:
A Pi-distributable collection of resources and their dependencies. One package can supply several presets, and one preset can draw resources from several packages.
_Avoid_: preset

**Preset definition**:
The authored declaration of a preset's identity, composition, requirements, and preferences. A definition describes the intended environment, not what is currently installed or active.
_Avoid_: installed revision, active configuration

**Installed revision**:
An identified, locally available revision of a preset together with its resolved resources. Installed does not mean active or authorized to execute.
_Avoid_: active preset, version label alone

**Session binding**:
The association of a session branch with its preset, effective revision, overrides, and revision-selection mode. It is distinct from the current global default; following an approved newer revision and remaining pinned to an exact revision are different bindings, neither of which alone proves resource availability.
_Avoid_: global default, guaranteed restoration
