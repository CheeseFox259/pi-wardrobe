# Minimal Coding

The native-only reference preset for Pi CLI agent v1.1.0.

`Minimal Coding` provides a baseline coding configuration using Pi's built-in
tools (`read`, `edit`, `write`, `bash`), a default `medium` thinking level, and
scoped inspection guidelines appended to the system persona.

## Installation

Like community presets, `Minimal Coding` passes through the standard
discovery, review, approval, and launch pipeline:

1. **Review**: inspect the immutable review plan:
   ```sh
   /wardrobe install <source>
   ```
2. **Approve and install**: confirm by quoting the plan digest:
   ```sh
   /wardrobe install <source> --confirm <digest>
   ```
3. **Launch**: run the installed revision in an isolated Pi process:
   ```sh
   wardrobe run <revision>
   ```

## Exclusions

`Minimal Coding` deliberately declares:

- **No external packages**: `packages: {}` declares no npm or Git dependencies.
- **No external resources**: `resources: []` selects no third-party extensions,
  skills, prompts, or themes.
- **No Perfect Pi dependencies**: no subagent structures, MCP servers, external
  Skill frameworks, or provider-specific model routes.
- **Strict runtime boundaries**: Pi's default runtime built-ins remain separate
  from preset-provided resources.
