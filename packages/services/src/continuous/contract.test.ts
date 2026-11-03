// contract.test.ts：模块清单与公共入口契约——所有对外导出可从 contract.js 解析，
// 且与 domain 直连同源（防止 domain 内部重构悄悄改变公共面）。
import { describe, expect, it } from "vitest";

import { continuousModule } from "./module.js";
import * as contract from "./contract.js";
import * as budgetPolicy from "./domain/budgetPolicy.js";

describe("continuous contract", () => {
  it("declares its module manifest", () => {
    expect(continuousModule.id).toBe("continuous");
    expect(continuousModule.publicEntrypoints).toEqual(["contract.ts"]);
  });

  it("公共入口导出完整的 domain 策略面", () => {
    for (const key of [
      "evaluateBudgetAdmission",
      "mergeContinuationGrants",
      "dayWindowFor",
      "assertValidTimeZone",
      "isProgramDue",
      "nextCycleAtFor",
      "scheduledTriggerKey",
      "evaluateCandidateClassification",
      "decisionBlocksCandidate",
      "mergeDecisionOnRediscovery",
      "planDecisionResolution",
      "selectCandidates",
      "candidateScore",
      "isOpenCycleStatus",
      "requiresProgramReauthorization",
    ] as const) {
      expect(contract, `contract 缺少导出 ${key}`).toHaveProperty(key);
    }
  });

  it("公共入口与 domain 实现同源（同一函数引用，不是复制）", () => {
    expect(contract.evaluateBudgetAdmission).toBe(budgetPolicy.evaluateBudgetAdmission);
    expect(contract.dayWindowFor).toBe(budgetPolicy.dayWindowFor);
  });
});
