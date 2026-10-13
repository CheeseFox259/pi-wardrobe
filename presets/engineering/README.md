# Perfect Pi Engineering

The curated engineering reference preset for Pi CLI agent v1.1.0.

`Perfect Pi Engineering` bundles 12 curated engineering skill families, structured interactive question and questionnaire extensions, and pinned native integrations for Guardrails (`@aliou/pi-guardrails@0.19.0`) and LSP (`@narumitw/pi-lsp@0.49.9`), operating at a `high` thinking level with persona domain guidance.

## What is Included

1. **Curated Skills (12 Families)**:
   - `route`: engineering intent routing.
   - `grilling`: relentless assumption testing and interactive questioning.
   - `domain-modeling`: ubiquitous language and ADR authoring.
   - `project-architecture`: seam discovery, layering, and deepening.
   - `to-spec`: requirements and user story synthesis.
   - `to-tickets`: vertical tracer-bullet slicing and dependency graphs.
   - `implement`: TDD implementation assisted by LSP diagnostics.
   - `tdd`: red-green-refactor cycles at tested seams.
   - `code-review`: two-axis review (Standards + Spec fidelity).
   - `verify-product`: acceptance and end-to-end user verification.
   - `research`: primary source technical investigation.
   - `setup-matt-pocock-skills`: repository conventions and tracker setup.

2. **Native Extensions**:
   - `extensions/question.ts`: structured single-question tool (`question`).
   - `extensions/questionnaire.ts`: structured sequence questionnaire tool (`questionnaire`).
   - `@aliou/pi-guardrails@0.19.0`: explicit entry path `extensions/guardrails/index.ts`.
   - `@narumitw/pi-lsp@0.49.9`: explicit entry path `dist/index.ts`, registering `lsp_diagnostics` and `lsp_fix`.

3. **Runtime Configuration**:
   - Enabled tools: `question`, `questionnaire`, `lsp_diagnostics`, `lsp_fix`.
   - Thinking level: `high`.
   - Persona: Appended domain language and verification evidence guidance.

## Installation and Launch

Like all Wardrobe presets, `Perfect Pi Engineering` passes through the standard public pipeline:

1. **Review**: inspect the immutable review plan:
   ```sh
   /wardrobe install <source>
   ```
2. **Approve and install**: confirm by quoting the review plan digest:
   ```sh
   /wardrobe install <source> --confirm <digest>
   ```
3. **Launch**: run the verified revision in an isolated Pi process:
   ```sh
   wardrobe run <revision>
   ```

## Visible Limits & Truthful Unavailability

- **External Language Server**: The LSP tools (`lsp_diagnostics`, `lsp_fix`) require external language servers installed on the host. Language servers are **never** automatically installed by Pi or Wardrobe. When an external language server is absent, the workflow must be reported as **unavailable** before attempting diagnostics.
- **Guardrails Policy Boundaries**: Loading `@aliou/pi-guardrails@0.19.0` does not enforce undeclared or private policies. Only explicitly selected entry paths (`extensions/guardrails/index.ts`) are evaluated; unselected modules (such as `herdr` or `path-access`) remain inactive.
- **No Heavy Defaults**: No SoL-Pi, browser automation, web search, subagent delegation, or tmux orchestrator dependencies are included by default.
- **Prerequisite Truthfulness**: Missing workflow prerequisites report unavailable before entering that workflow; they are never silently installed or falsely claimed. Unavailable workflows do not cause available tools to fail.
- **Environment Isolation**: The reference preset is strictly optional and leaves personal configurations, auth credentials, and live Perfect Pi settings completely untouched.
