// Actionable, path-specific diagnostics.
//
// Every rejection names the exact location in the declaration and says what a
// preset author should do instead. A bare "invalid preset" is not acceptable:
// declarations are authored by hand and by strangers.

/** Keys that look plausible to a preset author but are deliberately excluded. */
const UNSUPPORTED = [
  {
    match: /^(pre|post)?(install|prepare|prepare:.*|scripts?)$/i,
    reason:
      "script hooks are not part of the preset contract; declare packages and resources instead",
  },
  {
    match: /^(mcpServers?|mcp)$/i,
    reason: "MCP server definitions are out of scope for presets in V1",
  },
  {
    match: /^(credentials?|auth|apiKey|apiKeys|token|secret|secrets|env|password)$/i,
    reason:
      "a preset cannot declare credentials; users authenticate through Pi's own flows",
  },
  {
    match: /^(private|internal|plugin)$/i,
    reason: "plugin-private configuration is not part of the public preset contract",
  },
];

export class WardrobeDiagnostic {
  constructor({ path, reason, hint }) {
    this.path = path;
    this.reason = reason;
    this.hint = hint ?? null;
  }

  toString() {
    const location = this.path || "declaration";
    return this.hint
      ? `${location}: ${this.reason}. ${this.hint}`
      : `${location}: ${this.reason}`;
  }

  toJSON() {
    return { path: this.path, reason: this.reason, hint: this.hint };
  }
}

/** A rejection carrying one or more path-specific diagnostics. */
export class WardrobeError extends Error {
  constructor(message, { diagnostics = [], hint = null } = {}) {
    super(message);
    this.name = "WardrobeError";
    this.diagnostics = diagnostics;
    this.hint = hint;
  }

  static from(message, diagnostics, hint) {
    return new WardrobeError(message, { diagnostics, hint });
  }

  /** Deterministic, readable rendering used by commands and tests. */
  format() {
    const lines = [this.message];
    for (const diagnostic of this.diagnostics) lines.push(`  - ${diagnostic}`);
    if (this.hint) lines.push(`  ${this.hint}`);
    return lines.join("\n");
  }

  toJSON() {
    return {
      message: this.message,
      diagnostics: this.diagnostics.map((diagnostic) => diagnostic.toJSON()),
      hint: this.hint,
    };
  }
}

/** Explain why a key is not allowed, if it is a known-excluded concept. */
export function unsupportedReason(key) {
  return UNSUPPORTED.find((entry) => entry.match.test(key))?.reason ?? null;
}

/** Render any thrown value as a diagnostic list without leaking a stack. */
export function describeFailure(error) {
  if (error instanceof WardrobeError) return error.format();
  return error instanceof Error ? error.message : String(error);
}
