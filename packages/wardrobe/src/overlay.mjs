// User and session overlays.
//
// An overlay carries idle, soft-switchable preferences and nothing else. It is
// not a preset and it is not a settings file: it cannot declare a package, a
// resource or any other executable dependency, because those belong to a
// reviewed revision and a change to them is a new one.
//
// The user's overlay lives beside the manager's own data so it is visible and
// removable; a session overlay is whatever the running session decided, which
// in V1 is a file the caller names.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { assertSoftOverlay } from "./compose.mjs";
import { validateOverlay } from "./schema.mjs";

/** The user's own overlay, relative to the agent directory. */
export const USER_OVERLAY = "user.json";

export function userOverlayPath(agentDir) {
  return join(agentDir, "wardrobe", USER_OVERLAY);
}

/**
 * The user's overlay layer, or null when there is none.
 *
 * An absent overlay is normal and contributes nothing. A malformed one is
 * refused: silently ignoring preferences the user wrote would report an
 * environment they did not ask for.
 */
export function readUserOverlay(agentDir) {
  const path = userOverlayPath(agentDir);
  if (!existsSync(path)) return null;
  return readOverlay(path, "user");
}

/** Read one overlay file as a layer of the given kind. */
export function readOverlay(path, kind) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw WardrobeError.from(`${path} is not readable JSON`, [
      new WardrobeDiagnostic({
        path: "",
        reason: error instanceof Error ? error.message : String(error),
        hint: "an overlay is a JSON object of soft preferences",
      }),
    ]);
  }
  const result = validateOverlay(raw, { origin: path });
  if (!result.ok) throw result.error;
  // The composition boundary re-checks the invariant, so a caller that builds
  // an overlay in memory cannot slip an executable field past the schema.
  assertSoftOverlay(result.definition, { origin: path });
  return { kind, identity: path, definition: result.definition };
}
