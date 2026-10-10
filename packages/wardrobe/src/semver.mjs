// Strict semantic-version syntax for preset metadata.
//
// V1 validates syntax only. Resolution of a range against the running Pi build
// belongs to the review and verification tickets; keeping them apart stops a
// range that merely parses from being reported as one that is satisfied.

const EXACT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
// A preset id may be namespaced, e.g. `wardrobe/minimal-coding`.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** True when `value` is an exact `major.minor.patch` version. */
export function isExactVersion(value) {
  return typeof value === "string" && EXACT.test(value);
}

/**
 * True when `value` is a supported compatibility range.
 *
 * Accepted forms: `*`, `1.x`, `>=1.1.0 <2.0.0`, `^1.1.0`, `~1.1.0`, or an exact
 * version. Anything else — URLs, ranges, `latest`, empty strings — is refused.
 */
export function isCompatibilityRange(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const terms = value.trim().split(/\s+/);
  return terms.every(isRangeTerm);
}

function isRangeTerm(term) {
  if (term === "*" || /^\d+(\.(x|\*))?(\.(x|\*))?$/.test(term)) return true;
  if (/^(\^|~)?\d+\.(\d+|x|\*)\.(\d+|x|\*)$/.test(term)) return true;
  const comparator = /^(>=|<=|>|<|=)\s*(\d+)\.(\d+|x|\*)(?:\.(\d+|x|\*))?$/;
  return comparator.test(term);
}

export function isSlug(value) {
  return typeof value === "string" && SLUG.test(value);
}
export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
