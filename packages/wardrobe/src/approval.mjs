// Plan storage and digest-bound approval.
//
// An approval is valid only for the exact plan content that was displayed.
// If the captured source or an artifact changes, the recomputed digest differs
// and the approval is refused. There is deliberately no "approve everything"
// path and no way to approve without presenting a digest first.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WardrobeDiagnostic, WardrobeError } from "./diagnostics.mjs";
import { digestMatches, digestOf } from "./plan.mjs";

export class PlanStore {
  constructor(agentDir) {
    this.root = join(agentDir, "wardrobe", "plans");
  }

  #pathFor(planId) {
    return join(this.root, `${planId}.json`);
  }

  save(sealed) {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.#pathFor(sealed.planId), `${JSON.stringify(sealed, null, 2)}\n`);
    return sealed;
  }

  read(planId) {
    const path = this.#pathFor(planId);
    if (!existsSync(path)) {
      throw WardrobeError.from("unknown review plan", [
        new WardrobeDiagnostic({ path: "/planId", reason: `no plan ${JSON.stringify(planId)}` }),
        new WardrobeDiagnostic({ path: "", reason: "run /wardrobe install to produce a plan" }),
      ]);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  /**
   * Record approval for a plan, only if the caller quotes its current digest.
   *
   * @param {{planId: string, digest: string, requireDisplayed: boolean}} request
   */
  approve({ planId, digest, requireDisplayed = true }) {
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
    if (requireDisplayed && digest !== stored.digest) {
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
