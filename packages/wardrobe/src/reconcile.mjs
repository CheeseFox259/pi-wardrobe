// Reconciling branch desired state with the running process runtime.
//
// In Pi, navigating between branches moves the active conversation to a
// different point in the session tree. A branch may carry soft overrides
// (tools, thinking, persona), or it may have been recorded under a
// different revision or an entirely different preset.
//
// Wardrobe guarantees safe branch-state navigation:
// 1. Soft overrides compatible with the active runtime are restored in place.
// 2. Follow branches stay on the currently running newer approved revision,
//    recording migration evidence rather than chasing installed revisions
//    in-process.
// 3. Incompatible states (different preset, strict revision mismatch, newer
//    revision required, missing resource) block the next model turn and supply
//    a relaunch plan (wardrobe run <preset> --resume <session-file>).
// 4. Executable resources are NEVER loaded or swapped in-process; history is
//    never rewritten or deleted.

import { planTools, planThinking, planPersona } from "./apply.mjs";
import { appliedAgainst } from "./session.mjs";
import { approvedAtOf, unmetRequirementsOf } from "./binding.mjs";

/**
 * Build a relaunch plan object for a blocked reconciliation.
 */
export function relaunchPlanFor({ preset, revision, sessionFile, reason }) {
  const target = preset ?? revision ?? "unknown";
  const fileArg = sessionFile ? ` --resume ${sessionFile}` : " --resume <session-file>";
  return {
    command: `wardrobe run ${target}${fileArg}`,
    reason,
    preset,
    revision,
    sessionFile: sessionFile ?? null,
  };
}

/**
 * Normalize a tool selection (plain names and/or `+name`/`-name` modifiers) into a list
 * of effective tool names.
 *
 * When entries contain only removals (`["-x"]`), it resolves as baseline minus these.
 * Otherwise, it resolves to plain names and additions minus removals.
 *
 * @param {Array<string|{tool: string}>} entries
 * @param {Array<string|{tool: string}>} [baseline=[]]
 * @returns {string[]}
 */
export function normalizeToolSelection(entries, baseline = []) {
  if (!entries || !Array.isArray(entries)) return [];
  const raw = entries
    .map((e) => (typeof e === "string" ? e : (e?.tool ?? "")))
    .filter(Boolean);
  if (raw.length === 0) return [];

  const additions = [];
  const removals = new Set();
  const plain = [];

  for (const item of raw) {
    if (item.startsWith("+")) {
      const name = item.slice(1).trim();
      if (name) additions.push(name);
    } else if (item.startsWith("-")) {
      const name = item.slice(1).trim();
      if (name) removals.add(name);
    } else {
      const name = item.trim();
      if (name) plain.push(name);
    }
  }

  // Removals-only: baseline minus these
  if (removals.size > 0 && additions.length === 0 && plain.length === 0) {
    const base = normalizeToolSelection(baseline);
    return [...new Set(base.filter((t) => !removals.has(t)))].sort();
  }

  const selected = new Set([...plain, ...additions]);
  for (const rem of removals) {
    selected.delete(rem);
  }
  return [...selected].sort();
}

/**
 * Compute the soft-field restore plan and detect if changes exist.
 */
export function computeSoftRestorePlan({ desired, runtime, restrictions = [], baseline = null }) {
  const currentTools = runtime?.tools ?? [];
  const availableTools = runtime?.availableTools ?? currentTools;
  const currentThinking = runtime?.thinking ?? null;
  const currentPersona = runtime?.persona ?? [];

  const baselineTools = baseline ?? runtime?.tools ?? [];
  const enabledNames = normalizeToolSelection(desired?.tools, baselineTools);
  const disabledNames = availableTools.filter((tool) => !enabledNames.includes(tool));

  const tools = planTools({
    wanted: {
      enabled: enabledNames.map((tool) => ({ tool })),
      disabled: disabledNames.map((tool) => ({ tool })),
      restricted: restrictions,
    },
    current: currentTools,
    available: availableTools,
  });

  const thinking = planThinking({
    preference: desired?.thinking ? { value: desired.thinking } : null,
    effective: currentThinking,
  });

  const persona = planPersona({
    wanted: desired?.persona ?? [],
    active: currentPersona,
  });

  const personaChanged = JSON.stringify(persona.resulting) !== JSON.stringify(currentPersona);
  const hasChanges = tools.changed || thinking.changed || personaChanged;

  return {
    tools,
    thinking,
    persona,
    personaChanged,
    hasChanges,
  };
}

/**
 * Pure reconciliation logic.
 *
 * Evaluates branch desired state against process state and manager store:
 * - "in-effect": compatible; returns soft-field restore plan.
 * - "follow-kept": stayed on running newer approved revision; returns migration evidence.
 * - "blocked": preset mismatch, strict mismatch, newer follow revision, or unmet resource;
 *              returns relaunch plan.
 */
export function reconcileState({
  desired: rawDesired,
  baseline = null,
  processState = {},
  reports = [],
  plans = new Map(),
  binding = null,
  sessionFile = null,
  runtime = null,
}) {
  const currentEffective = {
    tools: runtime?.tools ?? [],
    thinking: runtime?.thinking ?? null,
    persona: runtime?.persona ?? [],
  };

  const baselineTools = baseline?.tools ?? processState?.tools ?? runtime?.tools ?? [];

  const hasSessionEntry = Boolean(rawDesired && (rawDesired.appliedAt || rawDesired.revision));
  const desired = hasSessionEntry
    ? {
        preset: rawDesired?.preset ?? baseline?.preset ?? processState?.preset ?? null,
        mode: rawDesired?.mode ?? baseline?.mode ?? processState?.mode ?? binding?.mode ?? "follow",
        revision: rawDesired?.revision ?? baseline?.revision ?? processState?.revision ?? null,
        tools: normalizeToolSelection(rawDesired?.tools ?? baseline?.tools ?? processState?.tools ?? [], baselineTools),
        thinking: rawDesired?.thinking ?? baseline?.thinking ?? processState?.thinking ?? null,
        persona: rawDesired?.persona ?? baseline?.persona ?? processState?.persona ?? [],
      }
    : {
        preset: baseline?.preset ?? processState?.preset ?? null,
        mode: baseline?.mode ?? processState?.mode ?? binding?.mode ?? "follow",
        revision: baseline?.revision ?? processState?.revision ?? null,
        tools: normalizeToolSelection(baseline?.tools ?? processState?.tools ?? [], baselineTools),
        thinking: baseline?.thinking ?? processState?.thinking ?? null,
        persona: baseline?.persona ?? processState?.persona ?? [],
      };

  const currentRestrictions = [
    ...new Set([
      ...(processState.restrictions ?? []),
      ...(binding?.restrictions ?? []),
    ]),
  ];

  const intended = {
    tools: normalizeToolSelection(desired.tools, baselineTools),
    thinking: desired.thinking,
    persona: desired.persona,
  };
  const softReporting = appliedAgainst({ intended, effective: currentEffective });

  // 1. Preset mismatch check
  if (desired.preset && processState.preset && desired.preset !== processState.preset) {
    const reason = "preset mismatch";
    return {
      status: "blocked",
      reason,
      detail: `branch is bound to preset ${desired.preset}, but process is running ${processState.preset}`,
      relaunchPlan: relaunchPlanFor({ preset: desired.preset, revision: desired.revision, sessionFile, reason }),
      softFields: softReporting,
      desired,
    };
  }

  // 2. Unmet requirements / missing resource check on desired revision
  const desiredReport = reports.find((r) => r.revision === desired.revision);
  if (desiredReport) {
    const unmet = unmetRequirementsOf(desiredReport, plans);
    if (unmet.length > 0) {
      const reason = "missing resource";
      return {
        status: "blocked",
        reason,
        detail: `the revision cannot meet a requirement: ${unmet.join("; ")}`,
        relaunchPlan: relaunchPlanFor({
          preset: desired.preset || processState.preset,
          revision: desired.revision,
          sessionFile,
          reason,
        }),
        softFields: softReporting,
        desired,
      };
    }
  }

  // Check user restrictions: exact tool matching
  if (currentRestrictions.length > 0 && desiredReport) {
    const plan = plans.get(desiredReport.revision);
    const planEnabledNames = (plan?.runtime?.tools?.enabled ?? []).map((e) => (typeof e === "string" ? e : e.tool));
    const desiredToolNames = normalizeToolSelection(desired.tools, baselineTools);
    const activeToolNames = new Set([...planEnabledNames, ...desiredToolNames]);
    const restrictedSet = new Set(currentRestrictions);
    const restrictedViolations = [...restrictedSet].filter((toolName) => activeToolNames.has(toolName));
    if (restrictedViolations.length > 0) {
      const reason = "missing resource";
      return {
        status: "blocked",
        reason,
        detail: `unmet restrictions: tool ${restrictedViolations.join(", ")} is excluded by user restriction`,
        relaunchPlan: relaunchPlanFor({
          preset: desired.preset || processState.preset,
          revision: desired.revision,
          sessionFile,
          reason,
        }),
        softFields: softReporting,
        desired,
      };
    }
  }

  // 3. Strict mode mismatch check
  const mode = desired.mode || processState.mode || binding?.mode || "follow";
  if (mode === "strict") {
    if (desired.revision && processState.revision && desired.revision !== processState.revision) {
      const reason = "strict mismatch";
      return {
        status: "blocked",
        reason,
        detail: `strict mode requires pinned revision ${desired.revision}, but process is running ${processState.revision}`,
        relaunchPlan: relaunchPlanFor({
          preset: desired.preset || processState.preset,
          revision: desired.revision,
          sessionFile,
          reason,
        }),
        softFields: softReporting,
        desired,
      };
    }
    // Strict match: check if the pinned revision has drifted or gone missing
    if (!desiredReport || desiredReport.state !== "available") {
      const state = desiredReport ? desiredReport.state : "missing";
      const reason = state === "drifted" ? "drift" : "missing resource";
      return {
        status: "blocked",
        reason,
        detail: `the pinned revision ${desired.revision} is ${state}`,
        relaunchPlan: relaunchPlanFor({
          preset: desired.preset || processState.preset,
          revision: desired.revision,
          sessionFile,
          reason,
        }),
        softFields: softReporting,
        desired,
      };
    }
    return {
      status: "in-effect",
      reason: "strict match with active runtime",
      restorePlan: computeSoftRestorePlan({ desired, runtime, restrictions: currentRestrictions, baseline: baselineTools }),
      softFields: softReporting,
      desired,
    };
  }

  // 4. Follow mode: compare revisions and approval order
  if (desired.revision && processState.revision && desired.revision !== processState.revision) {
    const processReport = reports.find((r) => r.revision === processState.revision);
    const desiredAvailable = desiredReport && desiredReport.state === "available";
    const processAvailable = processReport && processReport.state === "available";

    if (!desiredAvailable && processAvailable) {
      // Desired revision is no longer available, but process is available -> keep process revision
      return followKeptResult({
        desired,
        processRevision: processState.revision,
        runtime,
        restrictions: currentRestrictions,
        softReporting,
        baselineTools,
      });
    }

    if (processReport && desiredReport) {
      const processApproved = approvedAtOf(processReport, plans);
      const desiredApproved = approvedAtOf(desiredReport, plans);
      const cmp = processApproved.localeCompare(desiredApproved);

      if (cmp >= 0) {
        // Process is newer-or-equal in approval order -> keep process revision
        return followKeptResult({
          desired,
          processRevision: processState.revision,
          runtime,
          restrictions: currentRestrictions,
          softReporting,
          baselineTools,
        });
      } else {
        // Desired revision is NEWER than process revision -> blocked!
        const reason = "missing resource";
        return {
          status: "blocked",
          reason,
          detail: `branch desired revision ${desired.revision} is newer than running revision ${processState.revision}`,
          relaunchPlan: relaunchPlanFor({
            preset: desired.preset || processState.preset,
            revision: desired.revision,
            sessionFile,
            reason,
          }),
          softFields: softReporting,
          desired,
        };
      }
    }

    // Fail closed if approval order cannot be established or revisions cannot be resolved
    const reason = "missing resource";
    return {
      status: "blocked",
      reason,
      detail: `cannot reconcile revision mismatch (${desired.revision} vs ${processState.revision}): approval order cannot be established`,
      relaunchPlan: relaunchPlanFor({
        preset: desired.preset || processState.preset,
        revision: desired.revision,
        sessionFile,
        reason,
      }),
      softFields: softReporting,
      desired,
    };
  }

  // 5. In-effect (compatible): verify revision is available
  if (desired.revision && (!desiredReport || desiredReport.state !== "available")) {
    const state = desiredReport ? desiredReport.state : "missing";
    const reason = state === "drifted" ? "drift" : "missing resource";
    return {
      status: "blocked",
      reason,
      detail: `the revision ${desired.revision} is ${state}`,
      relaunchPlan: relaunchPlanFor({
        preset: desired.preset || processState.preset,
        revision: desired.revision,
        sessionFile,
        reason,
      }),
      softFields: softReporting,
      desired,
    };
  }

  return {
    status: "in-effect",
    reason: "compatible with active runtime",
    restorePlan: computeSoftRestorePlan({ desired, runtime, restrictions: currentRestrictions, baseline: baselineTools }),
    softFields: softReporting,
    desired,
  };
}

function followKeptResult({ desired, processRevision, runtime, restrictions, softReporting, baselineTools = [] }) {
  const reason = "follow kept the running newer approved revision during tree navigation";
  return {
    status: "follow-kept",
    reason,
    keptFrom: desired.revision,
    keptTo: processRevision,
    migration: {
      at: new Date().toISOString(),
      from: desired.revision,
      to: processRevision,
      mode: "follow",
      reason,
    },
    restorePlan: computeSoftRestorePlan({ desired, runtime, restrictions, baseline: baselineTools }),
    softFields: softReporting,
    desired,
  };
}
