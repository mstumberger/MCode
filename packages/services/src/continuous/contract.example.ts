// contract.example.ts：公共入口的典型用法（编译期即契约文档；不参与运行时）。
import {
  dayWindowFor,
  evaluateBudgetAdmission,
  selectCandidates,
} from "./contract.js";

// 预算准入：整数微美元、预留制（§9）。
const admission = evaluateBudgetAdmission({
  cycleSummary: {
    settledCostMicros: 120_000,
    unsettledCostMicros: 30_000,
    settledTokens: 4_000,
    unsettledTokens: 500,
    unknownCostMicros: 0,
    unknownTokens: 0,
  },
  limits: { dailyCostMicros: 1_000_000, cycleCostMicros: 500_000, cycleTokens: 8_000 },
  reservedCostMicros: 10_000,
  reservedTokens: 200,
});
if (!admission.ok) {
  console.log(admission.limitKind, admission.observed?.limits.cycleCostMicros);
}

// 日窗口：Program 持久化时区（DST 安全）。
const window = dayWindowFor(Date.now(), "Asia/Shanghai");
console.log(window.key, window.startMs, window.endMs);

// 候选选择：scope 边界 + pending Decision 局部阻塞 + 有限名额。
const selection = selectCandidates({
  candidates: [
    {
      id: "c1",
      fingerprint: "fix-login-guard",
      targetPaths: ["src/auth/login.ts"],
      impact: 8,
      confidence: 0.8,
      effort: 2,
    },
  ],
  scope: { allowedPaths: ["src"], forbiddenPaths: ["src/gen"] },
  pendingDecisions: [],
  maxImprovements: 3,
});
console.log(selection.rationale);
