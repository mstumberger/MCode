// Continuous 领域切片（budget/cadence/decision/candidate 纯策略）的行为锁定测试。
// 规则来源与实现移植自 Huanxing-Lab/Cotaya（Apache-2.0，CT-04/05/06/07），
// 语义出处见各源文件头部注释与 docs/superpowers/plans/2026-10-29-cotaya-continuous-evaluation-plan.md。

import { describe, expect, it } from "vitest";

import {
  assertValidTimeZone,
  dayWindowFor,
  evaluateBudgetAdmission,
  mergeContinuationGrants,
  type UsageLedgerSummary,
} from "../../src/continuous/domain/budgetPolicy.js";
import {
  CONTINUOUS_RECOVERY_BACKOFF_MS,
  isProgramDue,
  manualTriggerKey,
  nextCycleAtFor,
  recoveryBackoffMs,
  scheduledTriggerKey,
  type Program,
} from "../../src/continuous/domain/cadencePolicy.js";
import {
  decisionBlocksCandidate,
  evaluateCandidateClassification,
  mergeDecisionOnRediscovery,
  planDecisionResolution,
  type DecisionResolutionInput,
} from "../../src/continuous/domain/decisionPolicy.js";
import { selectCandidates, candidateScore } from "../../src/continuous/domain/candidatePolicy.js";
import type { Candidate, Decision, DecisionOption } from "../../src/continuous/domain/types.js";

function ledger(partial: Partial<UsageLedgerSummary> = {}): UsageLedgerSummary {
  return {
    settledCostMicros: 0,
    unsettledCostMicros: 0,
    settledTokens: 0,
    unsettledTokens: 0,
    unknownCostMicros: 0,
    unknownTokens: 0,
    ...partial,
  };
}

describe("continuous budget admission（budgetPolicy）", () => {
  const limits = { dailyCostMicros: 1_000_000, cycleCostMicros: 500_000, cycleTokens: 8_000 };

  it("总额在 cycle 与 daily 限额内时放行", () => {
    const decision = evaluateBudgetAdmission({
      cycleSummary: ledger({ settledCostMicros: 100_000, unsettledCostMicros: 50_000 }),
      dailySummary: ledger({ settledCostMicros: 200_000 }),
      limits,
      reservedCostMicros: 50_000,
      reservedTokens: 1_000,
    });
    expect(decision.ok).toBe(true);
    expect(decision.limitKind).toBeUndefined();
  });

  it("日窗口超限拒绝并携带拒绝观测", () => {
    const decision = evaluateBudgetAdmission({
      cycleSummary: ledger(),
      dailySummary: ledger({ settledCostMicros: 950_000 }),
      limits,
      reservedCostMicros: 100_000,
      reservedTokens: 0,
    });
    expect(decision).toMatchObject({ ok: false, limitKind: "daily_cost" });
    expect(decision.observed?.limits).toEqual(limits);
    expect(decision.observed?.reservedCostMicros).toBe(100_000);
  });

  it("Unlimited（daily null）只跳过日额度，单轮限制仍生效", () => {
    const unlimited = { ...limits, dailyCostMicros: null };
    expect(
      evaluateBudgetAdmission({
        cycleSummary: ledger(),
        limits: unlimited,
        reservedCostMicros: 10_000_000,
        reservedTokens: 0,
      }).limitKind,
    ).toBe("cycle_cost");
    expect(
      evaluateBudgetAdmission({
        cycleSummary: ledger(),
        limits: unlimited,
        reservedCostMicros: 400_000,
        reservedTokens: 9_000,
      }).limitKind,
    ).toBe("cycle_tokens");
  });

  it("非安全整数或负预留按 unsafe_integer 拒绝", () => {
    for (const reservedCostMicros of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        evaluateBudgetAdmission({
          cycleSummary: ledger(),
          limits,
          reservedCostMicros,
          reservedTokens: 0,
        }).limitKind,
      ).toBe("unsafe_integer");
    }
  });

  it("继续 grant 只增量并入单轮上限，不扩大日额度", () => {
    const merged = mergeContinuationGrants(
      {
        dailyCostUsdMicros: 1_000_000,
        perCycleCostUsdMicros: 500_000,
        perCycleTokens: 8_000,
        activeExecutionLimitMs: 60_000,
      },
      [
        { costMicros: 100_000, tokens: 2_000, activeMs: 30_000 },
        { costMicros: 50_000 },
        {},
      ],
    );
    expect(merged).toEqual({
      dailyCostMicros: 1_000_000,
      cycleCostMicros: 650_000,
      cycleTokens: 10_000,
      activeExecutionLimitMs: 90_000,
    });
  });
});

describe("continuous 日窗口（budgetPolicy.dayWindowFor）", () => {
  it("UTC 固定日期窗口边界含首不含尾", () => {
    const at = Date.UTC(2026, 9, 15, 12, 30);
    const window = dayWindowFor(at, "UTC");
    expect(window.key).toBe("2026-10-15");
    expect(window.startMs).toBe(Date.UTC(2026, 9, 15));
    expect(window.endMs).toBe(Date.UTC(2026, 9, 16));
  });

  it("DST 春季前跳日为 23 小时、秋季回拨日为 25 小时（America/New_York）", () => {
    const spring = dayWindowFor(Date.UTC(2026, 2, 8, 12), "America/New_York");
    expect(spring.key).toBe("2026-03-08");
    expect(spring.endMs - spring.startMs).toBe(23 * 3_600_000);

    const fall = dayWindowFor(Date.UTC(2026, 10, 1, 12), "America/New_York");
    expect(fall.key).toBe("2026-11-01");
    expect(fall.endMs - fall.startMs).toBe(25 * 3_600_000);
  });

  it("非法时区显式抛错而不是回退 UTC", () => {
    expect(() => assertValidTimeZone("Mars/Olympus_Mons")).toThrowError(
      expect.objectContaining({ kind: "invalid_timezone" }),
    );
    expect(() => assertValidTimeZone("Asia/Shanghai")).not.toThrow();
  });
});

describe("continuous cadence（cadencePolicy）", () => {
  it("manual/scheduled 触发键稳定且可区分", () => {
    expect(manualTriggerKey("req-1")).toBe("manual:req-1");
    const program = { id: "p1", revision: 3 };
    expect(scheduledTriggerKey(program, 1_000)).toBe("scheduled:p1:3:1000");
    expect(scheduledTriggerKey(program, 1_000)).toBe(scheduledTriggerKey(program, 1_000));
  });

  it("恢复退避曲线 30s/120s，第三次起交由暂停询问", () => {
    expect(CONTINUOUS_RECOVERY_BACKOFF_MS).toEqual([30_000, 120_000]);
    expect(recoveryBackoffMs(0)).toBe(0);
    expect(recoveryBackoffMs(1)).toBe(30_000);
    expect(recoveryBackoffMs(2)).toBe(120_000);
    expect(recoveryBackoffMs(3)).toBeNull();
  });

  it("到期判定只唤醒 active/sleeping 且未归档的 Program", () => {
    const now = 1_000_000;
    const base = { nextCycleAt: now - 1, archivedAt: undefined };
    expect(isProgramDue({ ...base, status: "active" }, now)).toBe(true);
    expect(isProgramDue({ ...base, status: "sleeping" }, now)).toBe(true);
    expect(isProgramDue({ ...base, status: "paused" }, now)).toBe(false);
    expect(isProgramDue({ ...base, status: "completed" }, now)).toBe(false);
    expect(isProgramDue({ ...base, status: "active", nextCycleAt: now + 1 }, now)).toBe(false);
    expect(isProgramDue({ ...base, status: "active", archivedAt: now - 2 }, now)).toBe(false);
  });

  it("interval 到期为当前时刻加小时数；daily 取时区内的下一个未来本地时点", () => {
    const program = {
      timeZone: "Asia/Shanghai",
      cadence: { kind: "interval", hoursAfterCycleEnd: 6 },
    } as Program;
    expect(nextCycleAtFor(program, 1_000)).toBe(1_000 + 6 * 3_600_000);

    const daily = {
      timeZone: "Asia/Shanghai",
      cadence: { kind: "daily", localTime: "09:30" },
    } as Program;
    const now = Date.UTC(2026, 9, 15, 18, 0); // 北京时间 2026-10-16 02:00
    const next = nextCycleAtFor(daily, now);
    expect(new Date(next).toISOString()).toBe("2026-10-16T01:30:00.000Z"); // 北京 09:30
  });
});

describe("continuous 决策分类与阻塞（decisionPolicy）", () => {
  const scope = { allowedPaths: ["src", "docs"], forbiddenPaths: ["src/secret"] };

  it("双检查：操作能力先行，模型分类不是授权", () => {
    expect(
      evaluateCandidateClassification({ declared: "autonomous", targetPaths: ["src/secret/k.ts"], scope }),
    ).toEqual({ action: "excluded", reason: "forbidden_path" });
    expect(
      evaluateCandidateClassification({ declared: "autonomous", targetPaths: ["outside/x.ts"], scope }),
    ).toEqual({ action: "excluded", reason: "outside_allowed_paths" });
    expect(
      evaluateCandidateClassification({ declared: "maybe?", targetPaths: ["src/a.ts"], scope }),
    ).toEqual({ action: "to_decision", reason: "unknown_classification" });
    expect(
      evaluateCandidateClassification({ declared: "needs_decision", targetPaths: ["src/a.ts"], scope }),
    ).toEqual({ action: "to_decision", reason: "declared_needs_decision" });
    expect(
      evaluateCandidateClassification({ declared: "autonomous", targetPaths: ["src/a.ts"], scope }),
    ).toEqual({ action: "autonomous", reason: "dual_check_passed" });
  });

  it("路径按段前缀匹配，src 不匹配 srcfoo", () => {
    expect(
      evaluateCandidateClassification({ declared: "autonomous", targetPaths: ["srcfoo/a.ts"], scope }),
    ).toEqual({ action: "excluded", reason: "outside_allowed_paths" });
    expect(
      evaluateCandidateClassification({ declared: "autonomous", targetPaths: ["docs"], scope }),
    ).toEqual({ action: "autonomous", reason: "dual_check_passed" });
  });

  it("阻塞只经 candidateIds/paths 命中；capability 单独不阻塞、空 scope 阻塞零候选", () => {
    const candidate = { id: "c1", targetPaths: ["src/a.ts"] };
    expect(
      decisionBlocksCandidate(
        { id: "d1", blockingScope: { candidateIds: ["c1"], paths: [] } },
        candidate,
      ),
    ).toBe(true);
    expect(
      decisionBlocksCandidate(
        { id: "d1", blockingScope: { candidateIds: [], paths: ["src"] } },
        candidate,
      ),
    ).toBe(true);
    expect(
      decisionBlocksCandidate(
        { id: "d1", blockingScope: { candidateIds: [], paths: [], capability: "design-system" } },
        candidate,
      ),
    ).toBe(false);
    expect(decisionBlocksCandidate({ id: "d1", blockingScope: undefined }, candidate)).toBe(false);
    expect(decisionBlocksCandidate({ id: "d1", blockingScope: { candidateIds: [], paths: [] } }, candidate)).toBe(
      false,
    );
  });

  it("重复发现合并：首见身份稳定、终态不重开、来源按 cycle 去重、scope 取并集", () => {
    const options: DecisionOption[] = [{ id: "o1", label: "A", consequences: "x" }];
    const existing: Decision = {
      id: "d1",
      programId: "p1",
      sourceCycleId: "cy1",
      fingerprint: "f1",
      version: 2,
      title: "首见标题",
      context: "首见上下文",
      options,
      classification: "deferred",
      blockingScope: { candidateIds: ["c1"], paths: ["src"] },
      status: "resolved",
      resolution: { optionId: "o1", resolvedAt: 5 },
      sources: [{ cycleId: "cy1", discoveredAt: 1 }],
      createdAt: 1,
      updatedAt: 10,
    };
    const incoming: Decision = {
      ...existing,
      title: "措辞漂移的标题",
      blockingScope: { candidateIds: ["c2"], paths: ["docs"] },
      status: "pending",
      resolution: undefined,
      sources: [
        { cycleId: "cy1", discoveredAt: 2, context: "重复措辞" },
        { cycleId: "cy2", discoveredAt: 3 },
      ],
      updatedAt: 4,
    };
    const merged = mergeDecisionOnRediscovery(existing, incoming);
    expect(merged.title).toBe("首见标题");
    expect(merged.status).toBe("resolved");
    expect(merged.resolution?.optionId).toBe("o1");
    expect(merged.version).toBe(2);
    expect(merged.sources?.map((source) => source.cycleId)).toEqual(["cy1", "cy2"]);
    expect(merged.blockingScope).toEqual({ candidateIds: ["c1", "c2"], paths: ["src", "docs"] });
    expect(merged.updatedAt).toBe(10);
  });

  it("versioned resolve/dismiss：apply、幂等重放、version 冲突与非法选项", () => {
    const options: DecisionOption[] = [
      { id: "o1", label: "A", consequences: "x" },
      { id: "o2", label: "B", consequences: "y" },
    ];
    const pending: Decision = {
      id: "d1",
      programId: "p1",
      sourceCycleId: "cy1",
      fingerprint: "f1",
      version: 3,
      title: "t",
      context: "c",
      options,
      classification: "blocking",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
    const apply: DecisionResolutionInput = { kind: "resolve", version: 3, optionId: "o1" };
    expect(planDecisionResolution(pending, apply)).toEqual({ plan: "apply" });
    expect(planDecisionResolution(pending, { ...apply, version: 2 })).toEqual({
      plan: "version_conflict",
      currentVersion: 3,
    });
    expect(planDecisionResolution(pending, { ...apply, optionId: "o9" })).toEqual({
      plan: "invalid_option",
    });

    const resolved: Decision = {
      ...pending,
      version: 4,
      status: "resolved",
      resolution: { optionId: "o1", resolvedAt: 9 },
    };
    expect(planDecisionResolution(resolved, { kind: "resolve", version: 3, optionId: "o1" })).toEqual({
      plan: "idempotent",
    });
    expect(planDecisionResolution(resolved, { kind: "resolve", version: 3, optionId: "o2" })).toEqual({
      plan: "version_conflict",
      currentVersion: 4,
    });
    expect(planDecisionResolution(resolved, { kind: "dismiss", version: 3 })).toEqual({
      plan: "version_conflict",
      currentVersion: 4,
    });
  });
});

describe("continuous 候选选择（candidatePolicy）", () => {
  const scope = { allowedPaths: ["src"], forbiddenPaths: ["src/gen"] };

  function candidate(
    id: string,
    fingerprint: string,
    targetPaths: string[],
    impact: number,
    confidence: number,
    effort: number,
  ): Candidate {
    return {
      id,
      programId: "p1",
      sourceCycleId: "cy1",
      fingerprint,
      title: id,
      rationale: "",
      targetPaths,
      impact,
      confidence,
      effort,
      risk: "low",
      status: "pending",
      evidence: [],
      createdAt: 1,
      updatedAt: 1,
    };
  }

  it("按分数降序取前 N 项，并列按 fingerprint 稳定排序", () => {
    const high = candidate("c1", "f-high", ["src/a.ts"], 9, 0.9, 1);
    const mid = candidate("c2", "f-mid", ["src/b.ts"], 5, 0.5, 1);
    const low = candidate("c3", "f-low", ["src/c.ts"], 1, 0.1, 1);
    const tie1 = candidate("c4", "f-tie-a", ["src/d.ts"], 4, 0.5, 1);
    const tie2 = candidate("c5", "f-tie-b", ["src/e.ts"], 2, 1, 1);
    const result = selectCandidates({
      candidates: [low, mid, high, tie2, tie1],
      scope,
      pendingDecisions: [],
      maxImprovements: 3,
    });
    expect(result.selected.map((entry) => entry.candidate.fingerprint)).toEqual([
      "f-high",
      "f-mid",
      "f-tie-a",
    ]);
    expect(result.selected.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    // 落选但合格的不进 deferred：只是名额不够。
    expect(result.deferred).toEqual([]);
    expect(result.rationale).toContain("已选 3/5");
  });

  it("forbidden/越界候选推迟，pending Decision 只推迟命中阻塞面的候选", () => {
    const ok = candidate("c1", "f-ok", ["src/a.ts"], 5, 1, 1);
    const forbidden = candidate("c2", "f-forbidden", ["src/gen/x.ts"], 9, 1, 1);
    const outside = candidate("c3", "f-outside", ["docs/x.ts"], 9, 1, 1);
    const blocked = candidate("c4", "f-blocked", ["src/b.ts"], 9, 1, 1);
    const result = selectCandidates({
      candidates: [ok, forbidden, outside, blocked],
      scope,
      pendingDecisions: [{ id: "d1", blockingScope: { candidateIds: ["c4"], paths: [] } }],
      maxImprovements: 3,
    });
    expect(result.selected.map((entry) => entry.candidate.id)).toEqual(["c1"]);
    expect(result.deferred).toEqual([
      { candidate: forbidden, reason: "forbidden_path", decisionIds: [] },
      { candidate: outside, reason: "outside_allowed_paths", decisionIds: [] },
      { candidate: blocked, reason: "blocked_by_pending_decision", decisionIds: ["d1"] },
    ]);
  });

  it("effort 为 0 时按极小值计分避免除零放大", () => {
    const zeroEffort = candidate("c1", "f-zero", ["src/a.ts"], 1, 1, 0);
    expect(candidateScore(zeroEffort)).toBeCloseTo(100);
  });
});
