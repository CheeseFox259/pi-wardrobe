// The public preset declaration: `preset.json`.
//
// Strict by design. An unknown field, an excluded concept, or malformed
// metadata is refused with the exact path that caused it, because presets are
// authored by strangers and a silent default is worse than a refusal.

import { WardrobeDiagnostic, WardrobeError, unsupportedReason } from "./diagnostics.mjs";
import { softOverlayViolation } from "./compose.mjs";
import { parseSource } from "./identity.mjs";
import {
  isCompatibilityRange,
  isExactVersion,
  isNonEmptyString,
  isSlug,
  isStringArray,
} from "./semver.mjs";

const SUPPORTED_SCHEMA_VERSIONS = [1];

const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"];

/** Field-by-field contract. Anything absent from this table is unknown. */
const FIELDS = {
  schemaVersion: { type: "integer", required: true },
  id: { type: "slug", required: true },
  name: { type: "text", required: true },
  version: { type: "exactVersion", required: true },
  description: { type: "text", required: false },
  author: { type: "text", required: false },
  compatibility: {
    type: "object",
    required: true,
    fields: {
      pi: { type: "range", required: true },
      platforms: { type: "stringArray", required: false },
    },
  },
  extends: {
    type: "object",
    required: false,
    fields: {
      source: { type: "source", required: true },
      presetPath: { type: "text", required: false },
    },
  },
  packages: { type: "aliasMap", required: false, value: { source: true } },
  resources: {
    type: "array",
    required: false,
    item: {
      type: "object",
      fields: {
        package: { type: "text", required: true },
        kind: { type: "enum", values: RESOURCE_KINDS, required: false },
        // An empty include is not a mistake: it is how a layer chooses to load
        // none of that package's resources. An omitted one inherits whatever a
        // lower layer selected, so both are meaningful.
        include: { type: "pathList", required: false, allowEmpty: true },
        exclude: { type: "pathList", required: false, allowEmpty: true },
      },
    },
  },
  runtime: {
    type: "object",
    required: false,
    fields: {
      tools: {
        type: "object",
        required: false,
        fields: {
          enable: { type: "stringArray", required: false },
          disable: { type: "stringArray", required: false },
        },
      },
      model: {
        type: "object",
        required: false,
        fields: {
          provider: { type: "text", required: false },
          id: { type: "text", required: false },
        },
      },
      thinking: { type: "enum", values: THINKING_LEVELS, required: false },
    },
  },
  persona: {
    type: "object",
    required: false,
    fields: { append: { type: "stringArray", required: false } },
  },
};

/**
 * Validate a parsed declaration.
 *
 * @returns {{ok: true, definition: object} | {ok: false, error: WardrobeError}}
 */
export function validateDefinition(raw, { origin = "preset.json" } = {}) {
  const diagnostics = [];
  if (!isPlainObject(raw)) {
    return failure("preset declaration must be a JSON object", [
      new WardrobeDiagnostic({
        path: "",
        reason: `expected an object, found ${describeType(raw)}`,
        hint: `check ${origin}`,
      }),
    ]);
  }

  const definition = checkObject(raw, "", FIELDS, diagnostics);

  if (definition && typeof definition.schemaVersion === "number") {
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(definition.schemaVersion)) {
      diagnostics.push(
        new WardrobeDiagnostic({
          path: "/schemaVersion",
          reason: `unsupported schema version ${definition.schemaVersion}`,
          hint: `supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
        })
      );
    }
  }

  if (diagnostics.length > 0) {
    return failure(`${origin} is not a valid preset declaration`, diagnostics);
  }
  return { ok: true, definition };
}

// Whether a resource's package is declared is *not* checked here: a preset may
// select resources from an alias an inherited parent declared, and only the
// composed chain can answer that. Composition refuses an unresolved alias with
// the same path-specific diagnostic.

/** The soft subset an overlay may declare, reusing the declaration's own spec. */
const OVERLAY_FIELDS = {
  runtime: FIELDS.runtime,
  persona: FIELDS.persona,
};

/**
 * Validate a user or session overlay.
 *
 * An overlay is a strict subset of a declaration: idle, soft-switchable
 * preferences only. Anything executable is refused here with the rule the
 * composition boundary also enforces, so an author is told where that field
 * belongs instead of only that it is unknown.
 *
 * @returns {{ok: true, definition: object} | {ok: false, error: WardrobeError}}
 */
export function validateOverlay(raw, { origin = "overlay.json" } = {}) {
  if (!isPlainObject(raw)) {
    return failure(`${origin} is not a valid overlay`, [
      new WardrobeDiagnostic({
        path: "",
        reason: `expected an object, found ${describeType(raw)}`,
        hint: "an overlay carries runtime and persona preferences",
      }),
    ]);
  }

  const diagnostics = [];
  const permitted = {};
  for (const [key, value] of Object.entries(raw)) {
    const violation = softOverlayViolation(key, `/${key}`);
    if (violation) diagnostics.push(violation);
    else permitted[key] = value;
  }
  const definition = checkObject(permitted, "", OVERLAY_FIELDS, diagnostics);

  if (diagnostics.length > 0) {
    return failure(`${origin} is not a valid overlay`, diagnostics);
  }
  return { ok: true, definition };
}

function checkObject(value, basePath, spec, diagnostics) {
  const result = {};
  for (const key of Object.keys(spec)) {
    // An explicit `undefined` is treated as absent: JSON cannot express it, and
    // a caller that builds a declaration in memory means the same thing.
    if (!(key in value) || value[key] === undefined) {
      if (spec[key].required) {
        diagnostics.push(
          new WardrobeDiagnostic({
            path: join(basePath, key),
            reason: "required field is missing",
          })
        );
      }
      continue;
    }
    const child = checkField(value[key], join(basePath, key), spec[key], diagnostics);
    if (child !== undefined) result[key] = child;
  }

  for (const key of Object.keys(value)) {
    if (key in spec || value[key] === undefined) continue;
    const reason = unsupportedReason(key);
    diagnostics.push(
      new WardrobeDiagnostic({
        path: join(basePath, key),
        reason: reason ?? "unknown field",
        hint: reason ? null : `known fields: ${Object.keys(spec).sort().join(", ")}`,
      })
    );
  }
  return result;
}

function checkField(value, path, spec, diagnostics) {
  switch (spec.type) {
    case "integer":
      return checkInteger(value, path, diagnostics);
    case "text":
      return checkText(value, path, diagnostics);
    case "slug":
      return checkSlug(value, path, diagnostics);
    case "exactVersion":
      return checkExactVersion(value, path, diagnostics);
    case "range":
      return checkRange(value, path, diagnostics);
    case "stringArray":
      return checkStringArray(value, path, diagnostics);
    case "pathList":
      return checkPathList(value, path, spec.allowEmpty === true, diagnostics);
    case "enum":
      return checkEnum(value, path, spec.values, diagnostics);
    case "source":
      return checkSource(value, path, diagnostics);
    case "object":
      return checkNested(value, path, spec, diagnostics);
    case "aliasMap":
      return checkAliasMap(value, path, spec.value, diagnostics);
    case "array":
      return checkArray(value, path, spec.item, diagnostics);
    default:
      throw new Error(`Unknown field spec ${spec.type}`);
  }
}

function checkNested(value, path, spec, diagnostics) {
  if (!isPlainObject(value)) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path,
        reason: `expected an object, found ${describeType(value)}`,
      })
    );
    return undefined;
  }
  return checkObject(value, path, spec.fields, diagnostics);
}

function checkAliasMap(value, path, valueSpec, diagnostics) {
  if (!isPlainObject(value)) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path,
        reason: `expected an object, found ${describeType(value)}`,
        hint: "packages maps a package name to { source }",
      })
    );
    return undefined;
  }
  const result = {};
  for (const [alias, entry] of Object.entries(value)) {
    const entryPath = `${path}/${alias}`;
    if (!isPlainObject(entry)) {
      diagnostics.push(
        new WardrobeDiagnostic({
          path: entryPath,
          reason: `expected an object, found ${describeType(entry)}`,
        })
      );
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!(key in valueSpec)) {
        diagnostics.push(
          new WardrobeDiagnostic({
            path: `${entryPath}/${key}`,
            reason:
              unsupportedReason(key) ??
              `unknown field; expected ${Object.keys(valueSpec).join(" or ")}`,
          })
        );
      }
    }
    if ("source" in entry) {
      const source = checkSource(entry.source, `${entryPath}/source`, diagnostics);
      if (source !== undefined) result[alias] = { ...entry, source };
    } else {
      diagnostics.push(
        new WardrobeDiagnostic({ path: `${entryPath}/source`, reason: "required field is missing" })
      );
    }
  }
  return result;
}

function checkArray(value, path, itemSpec, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path,
        reason: `expected an array, found ${describeType(value)}`,
      })
    );
    return undefined;
  }
  return value.map((entry, index) => {
    const entryPath = `${path}/${index}`;
    if (!isPlainObject(entry)) {
      diagnostics.push(
        new WardrobeDiagnostic({
          path: entryPath,
          reason: `expected an object, found ${describeType(entry)}`,
        })
      );
      return undefined;
    }
    return checkObject(entry, entryPath, itemSpec.fields, diagnostics);
  });
}

function checkInteger(value, path, diagnostics) {
  if (!Number.isInteger(value)) {
    pushType(diagnostics, path, "an integer", value);
    return undefined;
  }
  return value;
}

function checkText(value, path, diagnostics) {
  if (!isNonEmptyString(value)) {
    pushType(diagnostics, path, "a non-empty string", value);
    return undefined;
  }
  return value;
}

function checkSlug(value, path, diagnostics) {
  if (!isSlug(value)) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path,
        reason: `expected a lowercase slug, found ${JSON.stringify(value)}`,
        hint: "use letters, digits, single hyphens and an optional /namespace, e.g. wardrobe/minimal-coding",
      })
    );
    return undefined;
  }
  return value;
}

function checkExactVersion(value, path, diagnostics) {
  if (!isExactVersion(value)) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path,
        reason: `expected an exact version, found ${JSON.stringify(value)}`,
        hint: "a preset version is exact, e.g. 1.0.0",
      })
    );
    return undefined;
  }
  return value;
}

function checkRange(value, path, diagnostics) {
  if (!isCompatibilityRange(value)) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path,
        reason: `expected a supported version range, found ${JSON.stringify(value)}`,
        hint: 'e.g. ">=1.1.0 <2.0.0", "^1.1.0", "1.x" or "*"',
      })
    );
    return undefined;
  }
  return value;
}

function checkStringArray(value, path, diagnostics) {
  if (!isStringArray(value)) {
    pushType(diagnostics, path, "an array of strings", value);
    return undefined;
  }
  return [...value];
}

/**
 * Package-relative resource paths.
 *
 * They are resolved inside the declared package, so an absolute path or one
 * that climbs out of the package is refused here rather than at use time.
 */
function checkPathList(value, path, allowEmpty, diagnostics) {
  if (!isStringArray(value) || (!allowEmpty && value.length === 0)) {
    pushType(
      diagnostics,
      path,
      allowEmpty ? "an array of package-relative paths" : "a non-empty array of package-relative paths",
      value
    );
    return undefined;
  }
  for (const [index, entry] of value.entries()) {
    if (entry.trim() === "" || entry.startsWith("/") || entry.split("/").includes("..")) {
      diagnostics.push(
        new WardrobeDiagnostic({
          path: `${path}/${index}`,
          reason: `not a package-relative path: ${JSON.stringify(entry)}`,
          hint: "use a path inside the package, e.g. skills/review/SKILL.md",
        })
      );
    }
  }
  return [...value];
}

function checkEnum(value, path, values, diagnostics) {
  if (!values.includes(value)) {
    diagnostics.push(
      new WardrobeDiagnostic({
        path,
        reason: `expected one of ${values.join(", ")}, found ${JSON.stringify(value)}`,
      })
    );
    return undefined;
  }
  return value;
}

function checkSource(value, path, diagnostics) {
  if (!isNonEmptyString(value)) {
    pushType(diagnostics, path, "a source string", value);
    return undefined;
  }
  // Source syntax is owned by one parser so the schema and the resolver can
  // never disagree about what a valid source is.
  try {
    parseSource(value, path);
    return value;
  } catch (error) {
    if (error instanceof WardrobeError) {
      for (const diagnostic of error.diagnostics) diagnostics.push(diagnostic);
      return undefined;
    }
    throw error;
  }
}

function pushType(diagnostics, path, expected, value) {
  diagnostics.push(
    new WardrobeDiagnostic({
      path,
      reason: `expected ${expected}, found ${describeType(value)}`,
    })
  );
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(basePath, key) {
  return `${basePath}/${key}`;
}

function failure(message, diagnostics) {
  return {
    ok: false,
    error: WardrobeError.from(
      message,
      diagnostics,
      "fix the declaration and re-run; nothing was installed or changed"
    ),
  };
}
