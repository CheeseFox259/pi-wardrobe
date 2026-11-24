# Native Pi 1.3 capabilities

Use the native tool declarations as the executable contract. Pi and extensions use `pi update`; Wardrobe reconciles preset resources and skills after that update.

## Tools and codemode

Keep `defaultTools: ["+codemode"]` additive so package defaults and resumed tool choices survive. Explicit CLI restrictions still take precedence. Discover MCP tools through `searchTools()` or `describeNamespace()` when needed; namespaces also match server aliases. Read current input constraints and result declarations before writing a script. A failed tool with an output schema can resolve with a failure value; inspect it before treating the validation as successful.

Place a codemode `// @options:` directive on the first line. Use `image(await tools.read({path: "..."}))` to show an image. Native `image()` persists an image file for later turns. For requested image generation, read Pi's `docs/codemode.md` and use native `models.generateImages()` with the session credentials and available image models. Model choice and authentication remain native Pi.

## Extensions and conversation continuity

`before_agent_start` also runs for extension-triggered custom messages. Check `event.messageType` before accessing `prompt`; shared prompt guidelines should apply to both kinds of run. Context projections should preserve message identity and system-delta boundaries so provider caches remain useful. Nested codemode results stay structured; reduce only results that enter the conversation.

OCC reads effective native compaction settings, including model overrides. A boundary compaction may continue the parent task after an internal failure; user cancellation remains authoritative. The preset retains its explicit phase and durability gates before opportunistic compaction. Recovery sessions and old revisions remain available.

## Optional native preferences

Users can set `$schema` in their native configuration for editor validation. Theme schema: `https://pi.dev/schemas/theme.schema.json`. `sessionShareDestination` chooses the native `/share` destination. Remote terminal users can opt into `PI_CLIPBOARD_OSC52=1`. These preferences stay user controlled; a preset update does not enable uploads, change credentials or select a provider.
