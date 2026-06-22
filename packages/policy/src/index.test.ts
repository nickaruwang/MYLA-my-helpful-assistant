import { describe, expect, it } from "vitest";
import { classifyIntent } from "./index.js";

describe("classifyIntent", () => {
  it("keeps financial requests local and manual-risk sensitive", () => {
    const decision = classifyIntent({ text: "summarize my bank transactions" });

    expect(decision.privacyClass).toBe("financial");
    expect(decision.riskLevel).toBe("sensitive");
    expect(decision.approvalMode).toBe("manual");
    expect(decision.modelRoute).toBe("local");
  });

  it("marks vehicle commands as high risk", () => {
    const decision = classifyIntent({ text: "start charging my Tesla" });

    expect(decision.privacyClass).toBe("vehicle");
    expect(decision.riskLevel).toBe("high");
    expect(decision.approvalMode).toBe("manual");
  });
});
