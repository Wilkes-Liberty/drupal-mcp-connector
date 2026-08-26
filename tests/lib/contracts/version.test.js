import { describe, expect, it } from "vitest";
import {
  ADAPTER_CONTRACT_VERSION,
  ContractError,
  REASON,
  negotiateContractVersion,
} from "../../../src/lib/contracts/index.js";

describe("negotiateContractVersion", () => {
  it("defaults a missing request to the published 1.0 contract", () => {
    expect(negotiateContractVersion()).toBe("1.0");
    expect(negotiateContractVersion("")).toBe(ADAPTER_CONTRACT_VERSION);
    expect(negotiateContractVersion("1.1")).toBe("1.0");
  });

  it("rejects a different major", () => {
    try {
      negotiateContractVersion("2.0");
      throw new Error("expected negotiateContractVersion to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect(err.reason).toBe(REASON.INCOMPATIBLE_CONTRACT);
    }
  });
});
