import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import { ModelConfig, ModelConfigRules, parseZCodeBuiltinModelConfigRules } from "@zcode/provider";

const url = "https://opencode.ai/zen/go/v1";
// 修复依据：上游 v3.17.2 更新了 Go 站点成员（新增 minimax-m3.1-flash、kimi-k3.1-pro、
// claude-haiku-5-5、gpt-6-luna、grok-4.7、mimo-v2.6 系列；mimo-v2.5 系列与 gpt-5.6-luna、
// grok-4.6 改为默认停用），以下成员与默认启停按当前 zcode-builtin.json 如实维护。
const members = {
  "opencode-go-chat": [
    "minimax-m3.1-flash",
    "kimi-k3.1-pro",
    "glm-5.3-flash",
    "glm-5.3",
    "kimi-k3",
    "kimi-k2.7-code",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "mimo-v2.6-pro",
    "mimo-v2.6-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "glm-5.2",
    "glm-5.1",
    "kimi-k2.6",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "hy4-preview",
    "hy3",
  ],
  "opencode-go-messages": [
    "minimax-m3",
    "qwen3.8-max",
    "qwen3.8-flash",
    "claude-haiku-5-5",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
  ],
  "opencode-go-responses": ["gpt-6-luna", "grok-4.7", "gpt-5.6-luna", "grok-4.6"],
};
const enabled = new Set([
  "minimax-m3.1-flash",
  "kimi-k3.1-pro",
  "glm-5.3-flash",
  "glm-5.3",
  "kimi-k3",
  "kimi-k2.7-code",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "minimax-m3",
  "qwen3.8-max",
  "qwen3.8-flash",
  "claude-haiku-5-5",
  "gpt-6-luna",
  "grok-4.7",
]);
let rules: ModelConfigRules;
let templates: {
  templateId: string;
  config: {
    api: { type: string; baseUrl: string };
    access: unknown;
    logo: unknown;
    builtinModelIds: string[];
  };
}[];
/** 修复依据：上游 v3.17.2 起 Go 模板的 templateModelRules 不再只写 enabled：新成员
 * （gpt-6-luna、grok-4.7、claude-haiku-5-5、kimi-k3.1-pro、minimax-m3.1-flash、mimo-v2.6 系列）
 * 携带各自的 properties/optionSpecs，模板解析结果可与个人站点规则不同；其余成员仍只决定默认启停。 */
let templateRuleCarriesCapabilities: Set<string>;
beforeAll(async () => {
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
  templates = release.config.providerConfigRules.templateRules;
  templateRuleCarriesCapabilities = new Set(
    (release.config.modelConfigRules.templateModelRules as Array<{
      templateId?: string;
      modelId: string;
      config: Record<string, unknown>;
    }>)
      .filter(
        (rule) =>
          rule.templateId?.startsWith("opencode-go") &&
          Object.keys(rule.config).some((key) => key !== "enabled"),
      )
      .map((rule) => `${rule.templateId}\u0000${rule.modelId}`),
  );
});
const input = (modelId: string, apiType = "openai-chat-completions", baseUrl = url) => ({
  providerId: "personal-go",
  modelId,
  apiType,
  baseUrl,
});
const patch = (config: ModelConfig, level: string) =>
  compileModelOptionMaps({
    reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
    maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
  }).apply({}, { reasoningLevel: level, maxOutputTokens: 4096 });

describe("Todo149 Go 模板与自建供应商共用站点规则", () => {
  it.each(Object.entries(members))("%s 按官方协议列成员，模板只决定默认启停", (templateId, ids) => {
    const t = templates.find((t) => t.templateId === templateId)!;
    expect(t).toBeDefined();
    expect(t.config.builtinModelIds).toEqual(
      [...ids].sort((a, b) => Number(enabled.has(b)) - Number(enabled.has(a))),
    );
    expect(t.config.api).toEqual({
      type: templateId.endsWith("chat")
        ? "openai-chat-completions"
        : templateId.endsWith("messages")
          ? "anthropic-messages"
          : "openai-responses",
      baseUrl: url,
    });
    expect(t.config.access).toEqual({
      type: "api-key",
      apiKeyManagementUrl: "https://opencode.ai/auth",
    });
    expect(t.config.logo).toEqual({ type: "builtin", key: "opencode" });
    for (const modelId of ids) {
      const i = input(modelId, t.config.api.type);
      const fromTemplate = rules.resolve({ ...i, templateId });
      const manual = rules.resolve(i);
      expect(fromTemplate.validateComplete(), modelId).toEqual([]);
      expect(fromTemplate.enabled, modelId).toBe(enabled.has(modelId));
      if (!templateRuleCarriesCapabilities.has(`${templateId}\u0000${modelId}`)) {
        expect(fromTemplate.properties?.toJSON(), modelId).toEqual(manual.properties?.toJSON());
        expect(fromTemplate.optionSpecs?.toJSON(), modelId).toEqual(manual.optionSpecs?.toJSON());
      } else {
        // 带能力覆盖的新成员：模板规则自身给出完整的 properties/optionSpecs，且两档 patch 仍可用。
        expect(fromTemplate.properties?.toJSON(), modelId).toBeDefined();
        expect(fromTemplate.optionSpecs?.toJSON(), modelId).toBeDefined();
      }
      expect(manual.properties?.supportsNativeWebSearch, modelId).toBe(false);
      for (const level of fromTemplate.optionSpecs!.reasoningLevel!.values!)
        expect(() => patch(fromTemplate, level), `${modelId}/${level}`).not.toThrow();
    }
  });

  // 原因：GLM 落入通用四组参数兜底，Go 上游严格校验并拒绝 enable_thinking/reasoning。
  it.each(["glm-5.3", "glm-5.3-flash"])(
    "%s 每个档位仅发送 reasoning_effort，不修改其他站点",
    (modelId) => {
      for (const level of ["low", "high", "max"]) {
        expect(patch(rules.resolve(input(modelId)), level)).toEqual({
          reasoning_effort: level,
          max_tokens: 4096,
        });
        expect(patch(rules.resolve(input(modelId, undefined, `${url}/`)), level)).toEqual({
          reasoning_effort: level,
          max_tokens: 4096,
        });
      }
      for (const other of [
        "https://opencode.ai/zen/v1",
        "https://opencode.ai.evil.test/zen/go/v1",
        "https://opencode.ai/zen/go/v10",
        "https://other.test/zen/go/v1",
      ]) {
        expect(patch(rules.resolve(input(modelId, undefined, other)), "high")).toHaveProperty(
          "enable_thinking",
          true,
        );
      }
      expect(patch(rules.resolve(input(modelId, "anthropic-messages")), "high")).toHaveProperty(
        "thinking",
      );
    },
  );

  it.each([
    ["glm-5.2", ["high", "max"], 1000000, 131072],
    ["glm-5.1", ["enabled"], 202752, 32768],
    ["kimi-k3", ["max"], 1048576, 131072],
    ["kimi-k2.7-code", ["enabled"], 262144, 262144],
    ["deepseek-v4-pro", ["high", "max"], 1000000, 384000],
    ["hy3", ["none", "low", "high"], 256000, 128000],
    ["hy4-preview", ["none", "high"], 1024000, 64000],
  ] as const)("%s 使用 Go 能力而不是同名原厂默认", (id, levels, context, max) => {
    const c = rules.resolve(input(id));
    expect(c.optionSpecs?.reasoningLevel?.values).toEqual(levels);
    expect(c.properties?.contextWindow).toBe(context);
    expect(c.optionSpecs?.maxOutputTokens?.max).toBe(max);
  });

  it("视觉与桥接分离；Qwen 的 Go 输出上限不照搬原厂", () => {
    expect(rules.resolve(input("glm-5.3")).properties?.inputFormat.supportsImage).toBe(false);
    expect(rules.resolve(input("glm-5.3-flash")).properties?.inputFormat.toJSON()).toMatchObject({
      supportsImage: true,
      supportsVideo: true,
      supportsPdf: true,
    });
    expect(rules.resolve(input("deepseek-v4-flash")).properties?.inputFormat.supportsImage).toBe(
      false,
    );
    expect(
      rules.resolve(input("deepseek-v4-flash-vision-exp")).properties?.inputFormat.supportsImage,
    ).toBe(true);
    for (const id of ["qwen3.7-max", "qwen3.7-plus"])
      expect(rules.resolve(input(id, "anthropic-messages")).optionSpecs?.maxOutputTokens?.max).toBe(
        65536,
      );
  });

  it.each(["provider-model", "manual-provider-model"] as const)(
    "%s 的个人 Map 仍然优先",
    (type) => {
      const personal = new ModelConfigRules([
        {
          type,
          providerId: "personal-go",
          modelId: "glm-5.3",
          config: new ModelConfig({
            optionSpecs: {
              reasoningLevel: { values: ["high"], map: '{"custom_effort": reasoningLevel}' },
              maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' },
            },
          }),
        },
      ]);
      const c = ModelConfigRules.composeEffective(rules, personal).resolve(input("glm-5.3"));
      expect(patch(c, "high")).toEqual({ custom_effort: "high", max_tokens: 4096 });
      if (type === "manual-provider-model") expect(c.properties?.contextWindow).toBeUndefined();
    },
  );
});
