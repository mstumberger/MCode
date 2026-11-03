// continuous 模块对公共入口：本 PR 只引入 domain 层（预算/节奏/决策/候选纯策略），
// application/adapters 与服务面在 lease 对齐（E3）后再分批引入；公共面仅暴露 domain
// 策略与领域类型，调用方不得深入 domain/ 内部文件。
export {
  assertValidTimeZone,
  dayWindowFor,
  evaluateBudgetAdmission,
  mergeContinuationGrants,
  type BudgetAdmissionDecision,
  type BudgetAdmissionDenialLimit,
  type BudgetAdmissionLimits,
  type BudgetAdmissionObservation,
  type DayWindow,
  type UsageLedgerSummary,
} from "./domain/budgetPolicy.js";
export {
  CONTINUOUS_RECOVERY_BACKOFF_MS,
  isProgramDue,
  manualTriggerKey,
  nextCycleAtFor,
  recoveryBackoffMs,
  scheduledTriggerKey,
} from "./domain/cadencePolicy.js";
export {
  CONTINUOUS_MODEL_CLASSIFICATIONS,
  decisionBlocksCandidate,
  evaluateCandidateClassification,
  mergeDecisionOnRediscovery,
  planDecisionResolution,
  type CandidateClassificationAction,
  type DecisionResolutionInput,
  type DecisionResolutionPlan,
} from "./domain/decisionPolicy.js";
export { candidateScore, selectCandidates } from "./domain/candidatePolicy.js";
export type {
  Candidate,
  ContinuationGrant,
  ContinuationRequest,
  Decision,
  DecisionBlockingScope,
  DecisionOption,
  DecisionSourceRecord,
  Program,
  WorkspaceLease,
} from "./domain/types.js";
export { isOpenCycleStatus, isTerminalCycleStatus, requiresProgramReauthorization } from "./domain/types.js";
