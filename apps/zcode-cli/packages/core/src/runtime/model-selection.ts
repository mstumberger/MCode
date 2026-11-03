import { resolveExecutionState } from "@zcode/shared";
import type { Model, ModelSelection } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { readRuntimeExecutionState } from "./execution-state.js";
import { createRuntimeModel } from "./methods/runtime-model.js";

export function cloneModelSelection(selection: ModelSelection): ModelSelection {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

/**
 * 按工作类型的模型路由（docs/superpowers/specs/2026-11-03-dynamic-model-routing-design.md）。
 *
 * 路由只覆盖「没有显式选择」的调用点：用户提交的 intent.modelSelection、执行作用域
 * Selection（highspeed/execution）以及各 sidecar 自己的显式配置都高于路由。路由目标
 * 无法建模时退回会话模型并告警，配置错误不能阻断 turn 或 sidecar。
 */

/**
 * Plan 激活期间的普通 turn 默认选择。未配置 planMode 角色或 plan 未激活时返回会话
 * 选择（可能为空，维持未绑定 Session 的原有语义）；命中路由时 routed=true，供建模
 * 失败分支决定是否退回会话模型。
 */
export function resolvePlanRoutedSelection(
  runtime: AgentRuntimeInternal,
  intent: { mode?: string; planEnabled?: boolean } | undefined,
): { routed: boolean; selection: ModelSelection | undefined } {
  const routed = runtime.config.modelRouting?.planMode;
  if (!routed) return { routed: false, selection: runtime.getSessionModelSelection() };
  // 提交自身的 plan/mode 状态在 applySubmissionExecutionState 里才落盘，
  // admission 冻结事实时必须先按 intent 解析本轮生效状态，否则「随本条提交进入
  // plan」的那一轮仍会跑到会话模型上。
  const planEnabled = resolveExecutionState(
    { mode: intent?.mode, planEnabled: intent?.planEnabled },
    readRuntimeExecutionState(runtime),
  ).planEnabled;
  if (!planEnabled) return { routed: false, selection: runtime.getSessionModelSelection() };
  return { routed: true, selection: cloneModelSelection(routed) };
}

/** 总结类 sidecar 的默认选择；未配置 utility 角色时维持会话选择。 */
export function resolveUtilityModelSelection(
  runtime: AgentRuntimeInternal,
): ModelSelection | undefined {
  const routed = runtime.config.modelRouting?.utility;
  return routed ? cloneModelSelection(routed) : runtime.getSessionModelSelection();
}

/**
 * 创建总结类 sidecar 的执行 Model。utility 目标建模失败时退回会话模型并告警；
 * 两者都不可用时维持 createRuntimeModel 的原有 ConfigurationError 语义。
 */
export function createUtilityRuntimeModel(
  runtime: AgentRuntimeInternal,
  purpose: string,
): Model {
  const routed = runtime.config.modelRouting?.utility;
  if (!routed) {
    return createRuntimeModel(runtime, { selection: runtime.getSessionModelSelection() });
  }
  try {
    return createRuntimeModel(runtime, { selection: cloneModelSelection(routed) });
  } catch (error) {
    // 路由是便利配置而非用户显式意图：目标失效时 sidecar 必须继续可用，
    // 与 subagent 显式 profile「解析失败不落回父模型」的极性相反。
    const sessionSelection = runtime.getSessionModelSelection();
    runtime.logger?.warn("Model routing utility selection unavailable; using session selection", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "model.routing.utility.creation_fallback",
      module: "core.runtime",
      purpose,
      status: "completed",
      toModelId: sessionSelection?.modelId,
      toProviderId: sessionSelection?.providerId,
    });
    return createRuntimeModel(runtime, { selection: sessionSelection });
  }
}
