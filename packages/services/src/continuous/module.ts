/**
 * continuous 模块清单：预算/节奏/决策/候选的纯领域策略（Cotaya E2 试点，domain-only）。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 */
export const continuousModule = {
  id: "continuous",
  requires: ["shared"],
  provides: ["continuous-domain-policies"],
  publicEntrypoints: ["contract.ts"],
} as const;
