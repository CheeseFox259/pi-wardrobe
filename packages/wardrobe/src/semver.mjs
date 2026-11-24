// Strict semantic-version syntax for preset metadata, and range resolution.
//
// V1 validates declaration syntax. Resolving a declared range against a real
// Pi build happens where a running Pi exists — verification and the revision
// doctor — and reports `null` when the question cannot be answered, so an
// unresolvable range is never reported as a satisfied one.

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

/**
 * True when `version` satisfies `range`, or `null` when it cannot be decided.
 *
 * `null` is a first-class answer: an unparseable range, or a version this
 * manager cannot read, must never be reported as a satisfied range, because
 * that would turn an unknown into permission.
 */
export function satisfies(range, version) {
  if (!isCompatibilityRange(range)) return null;
  const target = parseVersion(version);
  if (!target) return null;
  return range
    .trim()
    .split(/\s+/)
    .every((term) => termMatches(term, target));
}

function termMatches(term, target) {
  if (term === "*") return true;
  if (term.startsWith("^") || term.startsWith("~")) {
    const lower = parseVersion(term.slice(1));
    if (!lower) return false;
    const upper = term.startsWith("^") ? caretUpper(lower) : tildeUpper(lower);
    return compare(target, lower) >= 0 && compare(target, upper) < 0;
  }
  const comparator = /^(>=|<=|>|<|=)?\s*(\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(term);
  if (!comparator) return false;
  const operator = comparator[1] ?? "=";
  const bound = parseBound(comparator[2]);
  if (!bound) return false;
  const order = compare(target, bound.lower);
  if (operator === ">=") return order >= 0;
  if (operator === "<=") return order <= 0;
  if (operator === ">") return order > 0;
  if (operator === "<") return order < 0;
  // `1.x`, `1.2.x` and a short `1.2` are wildcard lines, not exact versions:
  // the components that were not named are open, and only the named ones are
  // compared.
  if (bound.ceiling) return order >= 0 && compare(target, bound.ceiling) < 0;
  return order === 0;
}

/**
 * One range term as a lower bound plus, for a wildcard or short term, the
 * exclusive upper bound it implies.
 *
 * A wildcard stands for "everything from here to the next bump of the last
 * named component": `1.x` is every 1.y.z, `1.2.x` is every 1.2.z, and `1.2` is
 * every 1.2.z.
 */
function parseBound(term) {
  const parts = term.split(".");
  const named = [];
  let wildcard = false;
  for (const part of parts) {
    if (part === "x" || part === "*") {
      wildcard = true;
      break;
    }
    named.push(Number(part));
  }
  const numbers = [...named, 0, 0].slice(0, 3);
  const lower = { major: numbers[0], minor: numbers[1], patch: numbers[2], pre: [] };
  if (!wildcard && parts.length === 3) return { lower, ceiling: null };
  const bumped = [...named];
  bumped[bumped.length - 1] += 1;
  return {
    lower,
    ceiling: { major: bumped[0] ?? 0, minor: bumped[1] ?? 0, patch: bumped[2] ?? 0, pre: [] },
  };
}

function caretUpper({ major, minor }) {
  return major > 0
    ? { major: major + 1, minor: 0, patch: 0, pre: [] }
    : minor > 0
      ? { major: 0, minor: minor + 1, patch: 0, pre: [] }
      : { major: 0, minor: 0, patch: 1, pre: [] };
}

function tildeUpper({ major, minor }) {
  return { major, minor: minor + 1, patch: 0, pre: [] };
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** Ordering where a release is greater than any of its pre-releases. */
function compare(a, b) {
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const left = a.pre[index];
    const right = b.pre[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return Number(left) < Number(right) ? -1 : 1;
    // Numeric identifiers always compare lower than alphanumeric ones.
    if (leftNumber) return -1;
    if (rightNumber) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Pi presets declare a minimum runtime. Legacy exact/caret/tilde/wildcard
 * shorthand also denotes that floor; explicit comparator constraints retain
 * their meaning. A higher runtime still loads resources through native Pi. */
export function supportsPi(requirement, version) {
  if (!isCompatibilityRange(requirement)) return null;
  const value=requirement.trim();
  if(value==='*')return satisfies('*',version);
  if(!value.includes(' ')&&!/^[<>=]/.test(value)){
    const shorthand=value.replace(/^[\^~]/,'');
    const bound=parseBound(shorthand);
    if(!bound)return null;
    return satisfies(`>=${bound.lower.major}.${bound.lower.minor}.${bound.lower.patch}`,version);
  }
  return satisfies(value,version);
}
