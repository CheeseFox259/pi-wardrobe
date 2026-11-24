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

**Preset draft**:
An editable candidate source for a preset, kept separately from installed revisions. Manual changes and Pi-assisted authoring share the draft; saving requires review, and saving does not activate it.
_Avoid_: active environment, recovery backup, approved revision

**Session binding**:
The association of a session branch with its preset, effective revision, overrides, and revision-selection mode. It is distinct from the current global default; following an approved newer revision and remaining pinned to an exact revision are different bindings, neither of which alone proves resource availability.
_Avoid_: global default, guaranteed restoration

**Startup default**:
The preset selected for a new Pi invocation when no saved session or explicit preset selection takes precedence. A project can have its own startup default; changing the preset of a current session is a separate choice.
_Avoid_: active session, session binding

**Local derivative**:
A locally maintained preset descended from an identified upstream revision, with recorded resource or preference changes. It retains its ancestry so an upstream update can be distinguished from the user's changes.
_Avoid_: upstream release, silent mutation

**Original configuration preset**:
A local preset representing the user's global resources and eligible preferences at their first Wardrobe adoption, managed through the same operations as other presets. The original recovery backup, project configuration, and Pi-owned model and authentication settings are separate from it.
_Avoid_: credential backup, merged project configuration

**Device binding**:
A device-local association between a preset's declared environment requirement and the machine-specific resource satisfying it. A shared preset carries the requirement, while local paths, private configuration references, and binding values remain on the device. Pi-owned model and authentication settings remain separate.
_Avoid_: portable resource, shared credential, model configuration


### Update

Upstream and installed-Pi capability reconciliation. The program compares the exact cached upstream base, local adaptation and current upstream target. It preserves local-only work and applies safe incoming files, then hands only changed capabilities and overlaps to the current Pi model. NO_UPDATE ends without a model turn. A reviewed target receipt can suppress repeated deferred work; it is distinct from a successfully integrated resource base.

### Maintain

A user-requested preset bug fix or capability addition. It works on a separate candidate and does not poll or upgrade unrelated upstream resources. Both workflows verify affected behavior and install an inactive immutable revision; only successful update integration advances its resource lineage.

### Shared workflow method

The update or maintenance procedure that applies to every standard preset. It defines how work is prepared, reviewed, verified, and installed, independently of a preset’s product choices.

### Workflow work item

An independently addressable decision or cohesive group of related decisions within an update or maintenance task. Work items need not be completed in a fixed order; a blocked required item prevents final completion but not independent work.

### Workflow focus

The model-selected work item whose evidence is currently being reviewed. A focus is a working view, not a completion gate or an obligation to finish that item before switching.

### Decision ledger

The durable record of work-item decisions, saved changes, verification findings and blockers. It is distinct from raw investigation observations and does not by itself prove final verification or installation eligibility.

### Preset design policy

A preset’s purpose, feature tradeoffs, and preservation constraints. It guides decisions within the shared workflow method. It is distinct from execution instructions and does not substitute for verification evidence.

### Component maintenance contract

A preset-owned statement of a component’s default behavior, preservation boundaries, permitted changes, and expected behavior under maintenance. It makes the preset’s design policy concrete for that component. It does not prescribe the shared execution procedure or prove that a candidate satisfies the contract.

### Workflow implementation item

A bounded, addressable obligation to implement an intended behavior or configuration change within an update or maintenance task. It connects the requirement or decision that creates the obligation with the expected outcome and its verification. Recording the originating decision does not discharge the implementation obligation.

### Runtime loading check

Program-owned evidence that the actual candidate loads on the target Pi runtime. It is distinct from review of new capabilities, fulfillment of explicit integration requirements, and verification of affected behavior. Successful loading alone does not make a candidate installable.

### Minimum Pi requirement

The minimum Pi runtime a preset needs. New authoring uses `>=version`; legacy exact, caret, tilde and wildcard shorthand are interpreted as a floor. Explicit comparator constraints remain explicit. A higher Pi version alone does not invalidate an unchanged preset or require reinstalling it. Native resource loading reports actual API failures; this policy is not a claim that every future API is certified.
