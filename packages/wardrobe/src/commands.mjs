// /wardrobe command dispatch.
//
// `list`, `show` and `explain` inspect; `install` reviews and, once the exact
// plan the user saw is approved, installs it into owned staging. Every result
// states plainly what is installed, what is active and what is only a
// proposal, and nothing outside this manager's own directories is written.
//
// `list` is read-only: it discovers and validates, and reports whether a
// snapshot already exists. Capturing happens when a preset is inspected.

import { PlanStore } from "./approval.mjs";
import { join } from "node:path";
import { WardrobeDiagnostic, describeFailure, WardrobeError } from "./diagnostics.mjs";
import { oneLine } from "./doctor.mjs";
import { resolveSelector } from "./identity.mjs";
import { readOverlay, readUserOverlay } from "./overlay.mjs";
import { renderResult } from "./render.mjs";
import { captureSource } from "./discover.mjs";
import { installApprovedPlan } from "./install.mjs";
import { diagnoseAll, diagnosePreset, selectRevision } from "./revisions.mjs";
import { stagingViewOf } from "./staging.mjs";
import { composeFor, planFor } from "./review.mjs";
import { PresetStore, discover, sourceDirs } from "./store.mjs";

const COMMANDS = ["list", "show", "explain", "install", "status", "doctor"];

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

/** Metadata a declaration describes about itself. */
const DECLARED_FIELDS = ["schemaVersion", "id", "name", "version", "description", "author", "compatibility"];

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
      try {
        return await install(command, positional[0] ?? null, flags, { dir, env });
      } catch (error) {
        // A failed install keeps its record: it is diagnostic state, and the
        // user needs to see what was left behind.
        if (error?.staging) {
          const entry = failure(command, error);
          entry.result.staging = stagingViewOf(error.staging);
          return entry;
        }
        throw error;
      }
    }

    // `status` and `doctor` answer about installed revisions, not about
    // declarations: a preset that is not discovered locally still has a
    // revision, and its state must be reportable either way. Awaited inside
    // the try, so a refused selector is reported rather than thrown.
    if (command === "status") {
      return await status(command, positional.join(" "), { dir, env });
    }
    if (command === "doctor") {
      return await doctor(command, positional.join(" "), { dir, env });
    }

    const store = new PresetStore(dir);
    const { presets, rejected } = discover(sourceDirs(dir, env));

    if (command === "list") {
      return await list(command, store, presets, rejected, { dir, env });
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
    const composed = await composition(resolved.preset, flags, { dir, env });
    // A preset's declared shape and the state of any revision built from it
    // are different facts; both are reported, neither is inferred from the
    // other.
    const { reports } = await diagnosePreset(
      dir,
      `${resolved.preset.source}#${resolved.preset.id}`,
      { env }
    );
    return success(command, {
      preset: { ...resolved.preset, state: "discovered", snapshotDir },
      definition: resolved.preset.definition,
      ...view(composed),
      revisions: reports.map(oneLine),
    });
  } catch (error) {
    return failure(command, error);
  }
}

/**
 * Compose a discovered preset the way the user asked to see it.
 *
 * A locally discovered declaration is presented as the capture composition
 * expects, so inheritance from a reviewed remote source resolves through the
 * same code path an installed one does.
 */
async function composition(preset, flags, { dir, env }) {
  const capture = {
    kind: "local",
    locator: preset.source,
    root: preset.source,
    treeDigest: null,
    presets: [preset],
  };
  const overlays = [readUserOverlay(dir)];
  const sessionPath = flags.get("overlay");
  if (typeof sessionPath === "string") overlays.push(readOverlay(sessionPath, "session"));

  return composeFor({
    captured: capture,
    preset,
    workDir: join(dir, "wardrobe", "captures"),
    registry: env.WARDROBE_REGISTRY,
    env,
    overlays: overlays.filter(Boolean),
    restrictions: restrictionsOf(flags),
  });
}

/**
 * Choices a preset may not override: CLI exclusions, the user's authorization
 * boundary, and an explicit user/CLI model choice.
 */
function restrictionsOf(flags) {
  const disabledTools = flags.get("disable-tool");
  const model = flags.get("model");
  return {
    disabledTools:
      typeof disabledTools === "string"
        ? disabledTools
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        : [],
    model: typeof model === "string" ? model : null,
  };
}

/** The described environment every inspecting command reports. */
function view({ layers, composed, executable, change }) {
  return {
    layers: layers.map((layer) => ({
      kind: layer.kind,
      identity: layer.identity,
      source: layer.captured?.locator ?? null,
      revision: layer.captured?.commit ?? layer.captured?.version ?? null,
    })),
    packages: composed.packages,
    resources: composed.resources.map(publicSelector),
    runtime: composed.runtime,
    persona: composed.persona,
    disabled: composed.runtime.tools.disabled,
    unmet: composed.runtime.tools.unmet,
    executable,
    // What the overlays changed. Soft by construction, so this is reported to
    // show that an overlay did not quietly require a new reviewed revision.
    revision: change,
    fields: composedFields(composed, layers),
    proposals: proposals(composed),
  };
}

/** The part of a folded selector a result carries; internal folds stay out. */
function publicSelector(selector) {
  return {
    package: selector.package,
    kind: selector.kind,
    generic: selector.generic,
    include: selector.include,
    exclude: selector.exclude,
    loaded: selector.loaded,
    excluded: selector.excluded,
    origins: selector.origins,
  };
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

  const userOverlay = readUserOverlay(dir);
  const sealed = await planFor({
    captured,
    preset,
    workDir: join(dir, "wardrobe", "captures"),
    registry: env.WARDROBE_REGISTRY,
    env,
    overlays: userOverlay ? [userOverlay] : [],
  });
  const quoted = typeof flags.get("confirm") === "string" ? flags.get("confirm") : null;
  // Without a quoted digest nothing is installed and no configuration changes:
  // approval is what separates a review from an install.
  if (quoted === null) {
    plans.save(sealed);
    return success(command, { state: "awaiting-approval", plan: sealed, approvedAt: null });
  }

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

  const approved = plans.approve({ planId: sealed.planId, digest: sealed.digest });
  const staging = await installApprovedPlan({
    plan: approved,
    agentDir: dir,
    env,
    registry: env.WARDROBE_REGISTRY,
  });

  return success(command, {
    state: staging.state,
    plan: sealed,
    approvedAt: approved.approved.at,
    installed: staging.state === "available",
    staging: stagingViewOf(staging.record, {
      selected: staging.attempt,
      alreadyAvailable: staging.alreadyAvailable,
    }),
  });
}

/**
 * Every installed revision, one line each, in stored order.
 *
 * Intended configuration is reported next to observed state, and the two are
 * never merged: a record that says `available` while the measurement says
 * `drifted` is reported as exactly that.
 */
async function status(command, selector, { dir, env }) {
  const { reports, unreadable } = await diagnoseAll(dir, { env });
  const selected = selector ? selectRevision(reports, selector, { unreadable }) : null;
  return success(command, {
    state: selected?.state ?? reportsSummary(reports),
    selected: selected ? oneLine(selected) : null,
    revisions: reports.map(oneLine),
    unreadable,
  });
}

/** The full diagnosis for one revision, or for every revision. */
async function doctor(command, selector, { dir, env }) {
  const { reports, unreadable } = await diagnoseAll(dir, { env });
  const selected = selector ? selectRevision(reports, selector, { unreadable }) : reports;
  const chosen = Array.isArray(selected) ? selected : [selected];
  return success(command, {
    state: reportsSummary(chosen),
    revisions: chosen,
    unreadable,
  });
}

/** The most serious state present, named plainly. */
function reportsSummary(reports) {
  if (reports.length === 0) return "none-installed";
  const states = reports.map((report) => report.state);
  for (const state of ["drifted", "failed", "missing", "unverified"]) {
    if (states.includes(state)) return state;
  }
  return "available";
}

async function list(command, store, presets, rejected, { dir, env }) {
  const { reports, unreadable } = await diagnoseAll(dir, { env });
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
      // Revisions are measured, not assumed: this list reports what is
      // installed here and what state each one is actually in.
      revisions: reports.map(oneLine),
      unreadable,
      installed: false,
      active: false,
    },
  };
}

/**
 * Every composed value with the layer it came from.
 *
 * Metadata describes the declaration itself; every other value names the layer
 * that contributed it, because "high" means nothing without knowing who asked
 * for it and which revision that was.
 */
function composedFields(composed, layers) {
  // The preset layer is the declaration a user asked about; a user or session
  // overlay sits above it and must not be mistaken for it.
  const declaration = layers.find((layer) => layer.kind === "preset") ?? layers.at(-1);
  const origin = `preset definition captured from ${declaration.preset?.capturedFrom ?? declaration.identity}`;
  const out = [];
  for (const key of DECLARED_FIELDS) {
    if (declaration.definition[key] === undefined) continue;
    walkField(declaration.definition[key], `/${key}`, FIELD_KINDS[key] ?? "metadata", origin, out);
  }

  out.push({ path: "/packages", kind: "composition", origin, applied: true, container: true });
  for (const entry of composed.packages) {
    const from = layerOrigin(entry.origin);
    out.push(field(`/packages/${entry.alias}/source`, entry.source, "composition", from));
    out.push(field(`/packages/${entry.alias}/version`, entry.version, "composition", from));
    out.push(field(`/packages/${entry.alias}/resource`, entry.canonical, "composition", from));
  }

  for (const selector of composed.resources) {
    const key = `/resources/${selector.package}:${selector.kind}`;
    out.push({
      path: key,
      kind: "composition",
      origin: describeOrigin(selectorOrigin(selector)),
      applied: true,
      container: true,
    });
    // Each loaded path is attributed to the layer that selected it, which is
    // not always the layer that wrote the selector it survives under.
    for (const path of selector.loaded) {
      out.push(field(`${key}/loaded/${path}`, path, "composition", pathOrigin(selector, path)));
    }
    for (const excluded of selector.excluded) {
      out.push({
        ...field(
          `${key}/excluded/${excluded.path}`,
          excluded.path,
          "composition",
          layerOrigin(excluded.origin)
        ),
        reason: excluded.reason,
      });
    }
  }

  out.push({ path: "/runtime", kind: "preference", origin, applied: false, container: true });
  const { tools, thinking, model } = composed.runtime;
  tools.enabled.forEach((entry, index) => {
    out.push(field(`/runtime/tools/enable/${index}`, entry.tool, "preference", layerOrigin(entry)));
  });
  tools.disabled.forEach((entry, index) => {
    out.push({
      ...field(`/runtime/tools/disable/${index}`, entry.tool, "preference", layerOrigin(entry)),
      reason: entry.reason,
    });
  });
  if (thinking) {
    out.push(field("/runtime/thinking", thinking.value, "preference", layerOrigin(thinking)));
  }
  if (model.value !== null) {
    out.push({
      ...field("/runtime/model", model.value, "preference", {
        layer: model.layer ?? model.winner,
        identity: model.identity ?? null,
      }),
      reason: model.reason ?? null,
    });
  }

  out.push({ path: "/persona", kind: "content", origin, applied: true, container: true });
  composed.persona.append.forEach((entry, index) => {
    out.push(field(`/persona/append/${index}`, entry.text, "content", layerOrigin(entry)));
  });
  return out;
}

function field(path, value, kind, origin) {
  return {
    path,
    value,
    kind,
    origin: describeOrigin(origin),
    applied: kind !== "preference",
    container: false,
  };
}

function describeOrigin(origin) {
  if (!origin) return "no layer";
  return origin.identity ? `${origin.layer} layer (${origin.identity})` : `${origin.layer} layer`;
}

function layerOrigin(origin) {
  if (!origin) return null;
  return { layer: origin.layer ?? null, identity: origin.identity ?? null };
}

/** The layer that wrote a selector, or the earliest one that contributed. */
function selectorOrigin(selector) {
  const origin = selector.origins[0];
  return origin ? layerOrigin(origin) : null;
}

/** The layer that selected one path, falling back to the selector's own. */
function pathOrigin(selector, path) {
  // The most recent action for a path is the effective one: a higher layer
  // re-including a path overrides the base that first named it.
  const origin = selector.origins.findLast((entry) => entry.path === path);
  return layerOrigin(origin ?? selector.origins[0]);
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

/**
 * Preferences that are declared but deliberately not applied.
 *
 * A preference the user or the CLI already decided is reported as such rather
 * than as something `use` would do, and an unmet preference keeps its reason.
 */
function proposals(composed) {
  const { tools, thinking, model } = composed.runtime;
  const out = [];
  if (thinking) out.push(`/wardrobe use would propose thinking level ${thinking.value} (${thinking.layer})`);
  if (model.value !== null) {
    out.push(
      model.winner === "user"
        ? `/wardrobe use would propose model ${model.value}, but an explicit user or CLI choice wins`
        : `/wardrobe use would propose model ${model.value}`
    );
  }
  if (tools.enabled.length > 0) {
    out.push(
      `/wardrobe use would propose enabling tools: ${tools.enabled.map((entry) => entry.tool).join(", ")}`
    );
  }
  if (tools.disabled.length > 0) {
    out.push(
      `/wardrobe use would propose disabling tools: ${tools.disabled.map((entry) => entry.tool).join(", ")}`
    );
  }
  for (const entry of tools.unmet) {
    out.push(
      `/wardrobe use would propose enabling tools: ${entry.tool} — refused: ${entry.reason}`
    );
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

function success(command, result) {
  return { ok: true, command, result: { ok: true, command, installed: false, active: false, ...result } };
}

function failure(command, error) {
  return {
    ok: false,
    command,
    result: { ok: false, command, error, text: describeFailure(error) },
  };
}
