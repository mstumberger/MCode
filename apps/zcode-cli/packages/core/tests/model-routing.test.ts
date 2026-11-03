import { describe, expect, it, vi } from "vitest";
import { CoreErrorType, createSessionId, type Logger } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { retainTitleModelContext } from "../src/runtime/methods/title-generation-sidecar.js";
import {
  createUtilityRuntimeModel,
  resolveUtilityModelSelection,
} from "../src/runtime/model-selection.js";

const SESSION_MODEL = createTestModelSelection("provider-a/model-a");
const PLAN_MODEL = createTestModelSelection("provider-flash/flash-model");
const UTILITY_MODEL = createTestModelSelection("provider-flash/utility-model");

function createWarnCapturingLogger(warn: ReturnType<typeof vi.fn>): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

function createRecordingModelFactory(
  requests: Array<{ modelId: string; providerId: string }>,
  options: { failCreationForProviderId?: string } = {},
) {
  return createTestModelFactory({
    onCreate(input) {
      if (
        options.failCreationForProviderId &&
        input.selection.providerId === options.failCreationForProviderId
      ) {
        throw Object.assign(new Error("registry cannot resolve routed selection"), {
          name: "CoreError",
          type: CoreErrorType.ConfigurationError,
        });
      }
    },
    async generateText(_request, observation) {
      requests.push({
        modelId: String(observation.model.modelId),
        providerId: String(observation.model.providerId),
      });
      return {
        finishReason: "stop",
        model: observation.model,
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
}

describe("model routing by work type", () => {
  it("plan-mode turns use the planMode routed model instead of the session model", async () => {
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("model-routing-plan-active"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { planMode: PLAN_MODEL },
        planEnabled: true,
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory(requests) },
    );

    await runtime.executeTurn("plan this feature");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      providerId: PLAN_MODEL.providerId,
      modelId: PLAN_MODEL.modelId,
    });
  });

  it("keeps the session model when plan mode is inactive or no planMode role is configured", async () => {
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("model-routing-plan-inactive"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { planMode: PLAN_MODEL },
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory(requests) },
    );

    await runtime.executeTurn("build this feature");

    expect(requests[0]).toMatchObject({
      providerId: SESSION_MODEL.providerId,
      modelId: SESSION_MODEL.modelId,
    });
  });

  it("routes the turn whose submission enables plan mode", async () => {
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("model-routing-plan-entry-turn"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { planMode: PLAN_MODEL },
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory(requests) },
    );

    // plan 状态由本条提交进入：admission 必须按 intent 解析生效状态，
    // 否则「进入 plan 的那一轮」仍跑在会话模型上。
    await runtime.executeTurn("enter plan and plan this feature", undefined, {
      intent: { planEnabled: true },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      providerId: PLAN_MODEL.providerId,
      modelId: PLAN_MODEL.modelId,
    });
  });

  it("explicit submission modelSelection beats plan routing", async () => {
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const explicit = createTestModelSelection("provider-b/model-b");
    const runtime = createTestAgentRuntime(
      createSessionId("model-routing-explicit-selection"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { planMode: PLAN_MODEL },
        planEnabled: true,
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory(requests) },
    );

    await runtime.executeTurn("use the model I picked", undefined, {
      intent: { modelSelection: explicit },
    });

    expect(requests[0]).toMatchObject({
      providerId: explicit.providerId,
      modelId: explicit.modelId,
    });
  });

  it("falls back to the session model when the planMode target cannot be created", async () => {
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const warn = vi.fn();
    const runtime = createTestAgentRuntime(
      createSessionId("model-routing-plan-creation-fallback"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { planMode: PLAN_MODEL },
        planEnabled: true,
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        logger: createWarnCapturingLogger(warn),
        modelFactory: createRecordingModelFactory(requests, {
          failCreationForProviderId: PLAN_MODEL.providerId,
        }),
      },
    );

    await runtime.executeTurn("plan even with a broken routed model");

    // 路由目标失效不能阻断 turn：退回会话模型继续本轮并告警。
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      providerId: SESSION_MODEL.providerId,
      modelId: SESSION_MODEL.modelId,
    });
    expect(warn).toHaveBeenCalledWith(
      "Plan-mode routed model unavailable; continuing on session model",
      expect.objectContaining({ event: "model.routing.plan_mode.creation_fallback" }),
    );
  });

  it("utility sidecars resolve the utility role and keep the session model when unset", async () => {
    const withUtility = createTestAgentRuntime(
      createSessionId("model-routing-utility-set"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { utility: UTILITY_MODEL },
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory([]) },
    );
    expect(resolveUtilityModelSelection(withUtility)).toEqual(UTILITY_MODEL);
    expect(createUtilityRuntimeModel(withUtility, "compact_summary")).toMatchObject({
      providerId: UTILITY_MODEL.providerId,
      modelId: UTILITY_MODEL.modelId,
    });

    const withoutUtility = createTestAgentRuntime(
      createSessionId("model-routing-utility-unset"),
      {
        modelSelection: SESSION_MODEL,
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory([]) },
    );
    expect(resolveUtilityModelSelection(withoutUtility)).toEqual(SESSION_MODEL);
  });

  it("utility creation falls back to the session model and warns when the target is unresolvable", () => {
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const warn = vi.fn();
    const runtime = createTestAgentRuntime(
      createSessionId("model-routing-utility-creation-fallback"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { utility: UTILITY_MODEL },
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        logger: createWarnCapturingLogger(warn),
        modelFactory: createRecordingModelFactory(requests, {
          failCreationForProviderId: UTILITY_MODEL.providerId,
        }),
      },
    );

    const model = createUtilityRuntimeModel(runtime, "compact_summary");

    expect(model).toMatchObject({
      providerId: SESSION_MODEL.providerId,
      modelId: SESSION_MODEL.modelId,
    });
    expect(warn).toHaveBeenCalledWith(
      "Model routing utility selection unavailable; using session selection",
      expect.objectContaining({ event: "model.routing.utility.creation_fallback" }),
    );
  });

  it("title sidecar keeps explicit title config above the utility role", () => {
    const explicitTitleModel = createTestModelSelection("provider-title/title-model");
    const runtime = createTestAgentRuntime(
      createSessionId("model-routing-title-precedence"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { utility: UTILITY_MODEL },
        titleGeneration: { enabled: true, modelSelection: explicitTitleModel },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory([]) },
    );

    expect(retainTitleModelContext(runtime).selection).toEqual(explicitTitleModel);

    const runtimeWithoutExplicit = createTestAgentRuntime(
      createSessionId("model-routing-title-utility"),
      {
        modelSelection: SESSION_MODEL,
        modelRouting: { utility: UTILITY_MODEL },
        titleGeneration: { enabled: true },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore(), modelFactory: createRecordingModelFactory([]) },
    );

    expect(retainTitleModelContext(runtimeWithoutExplicit).selection).toEqual(UTILITY_MODEL);
  });
});
