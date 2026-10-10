// /wardrobe command dispatch.
//
// Ticket 02 delivers inspection only: `list`, `show` and `explain`. Every
// result states plainly that nothing is installed and nothing is active, and
// that declared model/thinking/tool preferences are proposals.
//
// `list` is read-only: it discovers and validates, and reports whether a
// snapshot already exists. Capturing happens when a preset is inspected.

import { PlanStore } from "./approval.mjs";
import { join } from "node:path";
import { WardrobeDiagnostic, describeFailure, WardrobeError } from "./diagnostics.mjs";
import { resolveSelector } from "./identity.mjs";
import { renderResult } from "./render.mjs";
import { captureSource } from "./discover.mjs";
import { planFor } from "./review.mjs";
import { PresetStore, discover, sourceDirs } from "./store.mjs";

const COMMANDS = ["list", "show", "explain", "install"];

const FIELD_KINDS = {
  schemaVersion: "metadata",
  id: "identity",
  name: "metadata",
  version: "metadata",
  description: "metadata",
  author: "metadata",
  compatibility: "metadata",
  extends: "composition",
  packages: "composition",
  resources: "composition",
  runtime: "preference",
  persona: "content",
};

/** Resolve the agent directory Pi gave this process. */
function agentDir(env) {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) {
    throw WardrobeError.from(
      "Wardrobe cannot locate its agent directory",
      [],
      "PI_CODING_AGENT_DIR is not set; run /wardrobe inside Pi"
    );
  }
  return dir;
}

/** Parse `--flag value` pairs out of a command's arguments. */
function parseArgs(tokens) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(token.slice(2), true);
      } else {
        flags.set(token.slice(2), next);
        index += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

/**
 * Execute one /wardrobe invocation.
 *
 * @returns {Promise<{ok: boolean, command: string, result: object}>}
 */
export async function runCommand(input, { env = process.env } = {}) {
  const args = String(input ?? "").trim();
  const [name = "", ...tokens] = args.split(/\s+/).filter(Boolean);
  const command = name || "list";
  const { positional, flags } = parseArgs(tokens);

  if (!COMMANDS.includes(command)) {
    return failure(
      command,
      WardrobeError.from(
        `unknown /wardrobe subcommand ${JSON.stringify(command)}`,
        [],
        `available: ${COMMANDS.join(", ")}`
      )
    );
  }

  try {
    const dir = agentDir(env);
    if (command === "install") {
      // Awaited inside the try: a rejected promise must still become a
      // reported refusal rather than an unhandled error in the session.
      return await install(command, positional[0] ?? null, flags, { dir, env });
    }

    const store = new PresetStore(dir);
    const { presets, rejected } = discover(sourceDirs(dir, env));

    if (command === "list") {
      return list(command, store, presets, rejected);
    }

    const selector = positional.join(" ");
    if (!selector) {
      return failure(
        command,
        WardrobeError.from(
          `/wardrobe ${command} needs a preset`,
          [],
          `usage: /wardrobe ${command} <preset> — see /wardrobe list`
        )
      );
    }
    const resolved = resolveSelector(selector, presets);
    if (!resolved.ok) return failure(command, resolved.error);

    // Inspecting a preset is what captures it.
    const snapshotDir = store.write(resolved.preset, resolved.preset.definition);
    return {
      ok: true,
      command,
      result: {
        ok: true,
        command,
        preset: { ...resolved.preset, state: "discovered", snapshotDir },
        definition: resolved.preset.definition,
        installed: false,
        active: false,
        fields: command === "explain" ? explainFields(resolved.preset) : [],
        proposals: command === "explain" ? proposals(resolved.preset.definition) : [],
      },
    };
  } catch (error) {
    return failure(command, error);
  }
}

/**
 * Produce — never perform — an install.
 *
 * Discovery captures the source and reads registry metadata. Nothing is
 * installed and no configuration is changed, whether the user approves,
 * declines, or cancels.
 */
async function install(command, source, flags, { dir, env }) {
  if (!source) {
    return failure(
      command,
      WardrobeError.from("install needs a source", [], "e.g. npm:@scope/preset@1.0.0 or git:<url>@<sha>")
    );
  }
  const plans = new PlanStore(dir);
  const captured = await captureSource(source, {
    workDir: join(dir, "wardrobe", "captures"),
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    registry: env.WARDROBE_REGISTRY,
  });

  const wanted = typeof flags.get("preset") === "string" ? flags.get("preset") : null;
  if (captured.presets.length === 0) {
    return failure(
      command,
      WardrobeError.from("source declares no presets", [
        new WardrobeDiagnostic({
          path: "",
          reason: `${captured.locator} contains no valid preset.json`,
        }),
      ])
    );
  }
  if (wanted === null && captured.presets.length > 1) {
    return failure(
      command,
      WardrobeError.from(
        `source declares ${captured.presets.length} presets; explicit selection is required`,
        captured.presets.map(
          (preset) =>
            new WardrobeDiagnostic({
              path: "",
              reason: `candidate: ${preset.path} (${preset.definition.name})`,
            })
        ),
        `re-run with --preset <path>, e.g. --preset ${captured.presets[0].path}`
      )
    );
  }
  const preset = wanted
    ? captured.presets.find((entry) => entry.path === wanted)
    : captured.presets[0];
  if (!preset) {
    return failure(
      command,
      WardrobeError.from("no preset at that path", [], `available: ${captured.presets.map((p) => p.path).join(", ")}`)
    );
  }

  const sealed = await planFor({ captured, preset, registry: env.WARDROBE_REGISTRY, env });
  const quoted = typeof flags.get("confirm") === "string" ? flags.get("confirm") : null;
  let state = "awaiting-approval";
  let approved = null;
  if (quoted !== null) {
    if (quoted !== sealed.digest) {
      return failure(
        command,
        WardrobeError.from("approval digest does not match the plan", [
          new WardrobeDiagnostic({
            path: "/confirm",
            reason: `you quoted ${quoted}, the plan is ${sealed.digest}`,
          }),
          new WardrobeDiagnostic({
            path: "",
            reason: "the source or its artifacts changed since the plan was displayed",
          }),
        ])
      );
    }
    approved = plans.approve({ planId: sealed.planId, digest: sealed.digest });
    state = "approved";
  }
  plans.save(sealed);

  return {
    ok: true,
    command,
    result: {
      ok: true,
      command,
      state,
      plan: sealed,
      approvedAt: approved?.approved?.at ?? null,
      installed: false,
      active: false,
    },
  };
}

function list(command, store, presets, rejected) {
  return {
    ok: true,
    command,
    result: {
      ok: true,
      command,
      presets: presets.map((preset) => ({
        source: preset.source,
        id: preset.id,
        name: preset.name,
        version: preset.version,
        state: "discovered",
        snapshot: store.snapshotOf(preset),
      })),
      // Rejections are flattened to plain data: this result is appended to the
      // session and must survive serialization.
      rejected: rejected.map(serialiseRejection),
      installed: false,
      active: false,
    },
  };
}

/**
 * Every declared path with its origin, including nested leaves.
 *
 * Containers are marked so a renderer can show the leaves; the structured
 * result keeps everything.
 */
function explainFields(preset) {
  const origin = `preset definition captured from ${preset.capturedFrom}`;
  const out = [];
  for (const [key, value] of Object.entries(preset.definition)) {
    walkField(value, `/${key}`, FIELD_KINDS[key] ?? "metadata", origin, out);
  }
  return out;
}

function walkField(value, path, kind, origin, out) {
  const applied = kind !== "preference";
  if (isContainer(value)) {
    out.push({ path, kind, origin, applied, container: true });
    for (const [key, child] of Object.entries(value)) {
      walkField(child, `${path}/${key}`, kind, origin, out);
    }
    return;
  }
  out.push({ path, value, kind, origin, applied, container: false });
}

function isContainer(value) {
  return typeof value === "object" && value !== null;
}

/** Preferences that are declared but deliberately not applied. */
function proposals(definition) {
  const runtime = definition.runtime ?? {};
  const out = [];
  if (runtime.model) {
    const provider = runtime.model.provider ?? "(current provider)";
    out.push(
      `/wardrobe use would propose model ${provider}/${runtime.model.id ?? "(current)"}`
    );
  }
  if (runtime.thinking) {
    out.push(`/wardrobe use would propose thinking level ${runtime.thinking}`);
  }
  if (runtime.tools?.enable?.length) {
    out.push(`/wardrobe use would propose enabling tools: ${runtime.tools.enable.join(", ")}`);
  }
  if (runtime.tools?.disable?.length) {
    out.push(`/wardrobe use would propose disabling tools: ${runtime.tools.disable.join(", ")}`);
  }
  return out;
}

function serialiseRejection(error) {
  return { ...error.toJSON(), text: describeFailure(error) };
}

/** Attach the rendered text so the extension does not re-derive it. */
export function withText(entry) {
  return { ...entry, text: entry.ok ? renderResult(entry.result) : entry.result.text };
}

function failure(command, error) {
  return {
    ok: false,
    command,
    result: { ok: false, command, error, text: describeFailure(error) },
  };
}
