# pi-wardrobe

Manage Pi presets from Pi’s composer. Start with `pi`, open `/wardrobe`, and create, import, edit or switch working environments in the same terminal.

## Install from a checkout

Requires Node 22.19+ on macOS/Linux. The native integration has fixture coverage on macOS arm64 with Node 26.5.0. A daily Pi 1.6.0 installation also passed a compatibility update, targeted maintenance and preset handoff. The bundled Perfect Pi preset has its own runtime baseline. See the [live handoff](docs/handoffs/pi-wardrobe-native-2026-11-24.zh-CN.md) for the scope of that verification.

Install the extension once using native Pi:

```sh
pi install /path/to/pi-wardrobe/packages/wardrobe
pi
```

In Pi, enter `/wardrobe`. Review the first-use summary to create **我的原始配置** from global resources and preferences. Models, credentials, saved model choices and project configuration continue to use native Pi. Shared personal skills remain in their original locations.

The first screen is a searchable preset list. Enter uses a preset; → opens management; Ctrl+n creates; Ctrl+o imports. Create from the current environment, another preset, a blank definition, or with Pi. Edits stay in a draft until reviewed and saved, and saved versions stay inactive until selected.

Existing Pi configuration directories, including Perfect Pi, use **导入 → 本地**. Standard Git/npm preset repositories use the same import flow. Export shares public resources and declared device requirements; machine paths and private binding values stay local. Set global or project startup defaults separately from using a preset.

See the [中文操作指南](docs/usage.zh-CN.md) for the complete sequence, updates and recovery.

## Behavior

- Switching starts a new conversation in the same terminal after native Pi cleans up the old process. It does not change startup defaults.
- Native `/resume`, startup session selection and Wardrobe’s history menu restore the conversation’s preset. Original conversations remain recoverable.
- Import a standard GitHub/Git repository or an npm package; choose a preset when the repository contains several. Review exact packages, scripts, resources and compatibility once before installation.
- Update reviews compatibility and upstream changes, then asks for approval before implementation. Maintain applies a requested change in a separate candidate workspace. Verified changes install as a local revision with the old version retained.
- Pi and extensions, including Wardrobe, use native `pi update`. Wardrobe maintains preset source, upstream skills and compatibility.
- The current preset appears above the composer by default. A preset can use the public presentation event to move its identity into a custom footer.
- Normal startup checks only the selected prepared environment. It performs no remote update check, full history scan or extra Pi probe. Explicit verification and repair remain available in the composer.

## Documentation

- [中文操作指南](docs/usage.zh-CN.md)
- [实机交接记录](docs/handoffs/pi-wardrobe-native-2026-11-24.zh-CN.md)
- [Standard preset repositories](docs/preset-repository-standard.md)
- [Native manager commands](packages/wardrobe/README.md)
- [Approved behavior and verification evidence](docs/wardrobe-native-experience.md)
- [Preset redesign and acceptance](docs/planning/wardrobe-preset-redesign.md)
- [Domain glossary](CONTEXT.md), [architecture decisions](docs/adr/)
- [Legacy V1 CLI reference](docs/legacy-manager-reference.md)

The repository includes Minimal Coding, Perfect Pi Engineering and Perfect Pi Full. Full retains the migrated skills, extensions, prompts, themes, agents, habits and package dependencies; host programs such as language servers and tmux still need to exist when their features are used. [Migration details](docs/perfect-pi-migration-evidence.md).

## Development

```sh
npm test
npm run fixtures:report
```

Tests use isolated real Pi processes and controlled Git/npm sources. Package installation uses normal native Pi/npm permissions. Legacy recovery entry points remain available.
