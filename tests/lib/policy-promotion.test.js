import { describe, expect, it } from "vitest";
import {
  eligiblePromotions,
  normalizePromotions,
  promotionsRequired,
  resolveEligiblePromotion,
} from "../../src/lib/policy-promotion.js";

const DIGEST = "aa".repeat(32);
const OTHER = "bb".repeat(32);

function document(digest = DIGEST) {
  return {
    v: 1,
    denials: { operations: ["delete"] },
    expires: 0,
    id: "bundle-1",
    issued: 1,
    digest,
    seal: "hmac-sha256:deadbeef",
  };
}

describe("normalizePromotions (#253)", () => {
  it("is not required when the promotions table is omitted", () => {
    expect(promotionsRequired(null)).toBe(false);
    expect(promotionsRequired({ _comment: "lab" })).toBe(false);
    expect(normalizePromotions(null)).toBeNull();
    expect(eligiblePromotions(null)).toEqual([]);
  });

  it("requires two distinct operator ids and a matching sealed document", () => {
    const promotions = {
      [DIGEST]: {
        document: document(),
        approvals: ["operator-a", "operator-b"],
      },
    };
    expect(promotionsRequired(promotions)).toBe(true);
    expect(resolveEligiblePromotion({ digest: DIGEST, promotions })).toMatchObject({
      eligible: true,
      reason: null,
    });
    expect(resolveEligiblePromotion({ digest: DIGEST, promotions }).document.digest)
      .toBe(DIGEST);
  });

  it("refuses one approval, a repeated operator, and a digest mismatch", () => {
    expect(resolveEligiblePromotion({
      digest: DIGEST,
      promotions: { [DIGEST]: { document: document(), approvals: ["only-one"] } },
    })).toMatchObject({ eligible: false, reason: "not_entitled" });

    expect(resolveEligiblePromotion({
      digest: DIGEST,
      promotions: { [DIGEST]: { document: document(), approvals: ["alice", "alice"] } },
    })).toMatchObject({ eligible: false, reason: "not_entitled" });

    expect(resolveEligiblePromotion({
      digest: DIGEST,
      promotions: { [DIGEST]: { document: document(OTHER), approvals: ["a", "b"] } },
    })).toMatchObject({ eligible: false, reason: "not_entitled" });
  });

  it("refuses a missing seal and trims / lowercases digest keys", () => {
    expect(resolveEligiblePromotion({
      digest: DIGEST,
      promotions: {
        [DIGEST]: {
          document: { ...document(), seal: "not-hmac" },
          approvals: ["a", "b"],
        },
      },
    })).toMatchObject({ eligible: false, reason: "not_entitled" });

    const promotions = {
      [` ${DIGEST.toUpperCase()} `]: {
        document: { ...document(), digest: DIGEST.toUpperCase() },
        approvals: [" a ", "b"],
      },
    };
    expect(resolveEligiblePromotion({ digest: DIGEST, promotions })).toMatchObject({
      eligible: true,
    });
  });

  it("fail-closes a present table whose rows are all ineligible", () => {
    const promotions = { [DIGEST]: { document: document(), approvals: ["solo"] } };
    expect(promotionsRequired(promotions)).toBe(true);
    expect(eligiblePromotions(promotions)).toEqual([]);
    expect(resolveEligiblePromotion({ digest: DIGEST, promotions }).reason)
      .toBe("not_entitled");
  });
});
