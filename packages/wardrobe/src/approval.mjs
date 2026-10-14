// Plan storage and digest-bound approval.
//
// An approval is valid only for the exact plan content that was displayed.
// If the captured source or an artifact changes, the recomputed digest differs
// and the approval is refused. There is deliberately no "approve everything"
// path and no way to approve without presenting a digest first.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { digestMatches, digestOf } from "./plan.mjs";
import { assertSafeId } from "./staging.mjs";

export class PlanStore {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "plans");
  }

  #pathFor(planId) {
    assertSafeId(planId);
    return join(this.root, `${planId}.json`);
  }

  save(sealed) {
    assertSafeId(sealed.planId);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.#pathFor(sealed.planId), `${JSON.stringify(sealed, null, 2)}\n`);
    return sealed;
  }

  read(planId) {
    assertSafeId(planId);
    const path = this.#pathFor(planId);
    if (!existsSync(path)) {
      throw WardrobeError.from("unknown review plan", [
        new WardrobeDiagnostic({ path: "/planId", reason: `no plan ${JSON.stringify(planId)}` }),
        new WardrobeDiagnostic({ path: "", reason: "run /wardrobe install to produce a plan" }),
      ]);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  delete(planId) {
    assertSafeId(planId);
    const path = this.#pathFor(planId);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }

  /**
   * Record approval for a plan, only if the caller quotes its current digest.
   *
   * @param {{planId: string, digest: string}} request
   */
  approve({ planId, digest }) {
    const stored = this.read(planId);
    if (!digestMatches(stored)) {
      throw WardrobeError.from("stored plan no longer matches its digest", [
        new WardrobeDiagnostic({ path: "/digest", reason: "the stored plan has been modified" }),
        new WardrobeDiagnostic({
          path: "",
          reason: `expected ${digestOf(stored).slice(0, 16)}, stored ${stored.digest.slice(0, 16)}`,
        }),
      ]);
    }
    // The digest check is unconditional: there is no way to approve without quoting the displayed digest.
    if (digest !== stored.digest) {
      throw WardrobeError.from("approval digest does not match the displayed plan", [
        new WardrobeDiagnostic({
          path: "/digest",
          reason: `you quoted ${JSON.stringify(digest)}, the plan is ${stored.digest}`,
          hint: "re-run /wardrobe install and approve the digest it prints",
        }),
      ]);
    }
    const approved = { ...stored, approved: { digest: stored.digest, at: new Date().toISOString() } };
    this.save(approved);
    return approved;
  }

}
