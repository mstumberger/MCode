import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 永不 resolve：这些文件不测发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const { layerMock, sendCommandMock } = vi.hoisted(() => ({
  layerMock: {
    acquire: vi.fn(() => ({
      store: {
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        recoverFromStaleAuthority: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    })),
  },
  sendCommandMock: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: envelope.baseRevision ?? 0,
    }),
  ),
}));

// 捕获 Composer 收到的 props：本组测试直接调用 onSwitchMode 触发选择器点击路径。
const composerProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

const projectionState = vi.hoisted(() => ({
  current: null as
    | {
        status: "live";
        snapshot: ConversationSnapshot;
        subscriptionId: string;
        lastError: null;
        optimisticCommands: readonly [];
        loadingOlder: boolean;
      }
    | {
        status: "closed";
        snapshot: null;
        subscriptionId: null;
        lastError: null;
        optimisticCommands: readonly [];
        loadingOlder: boolean;
      }
    | null,
}));

const servicesMock = vi.hoisted(() => ({
  highspeedCardService: {
    getSnapshot: vi.fn(async () => ({ card: null, nextDrawAt: null, drawing: false })),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  },
  // 修复原因：readiness hook 将 service 作为 effect 依赖；每次 render 重建会导致无限重渲染直至 OOM。
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
    readSession: vi.fn(async () => ({})),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
  // 草稿态 model readiness gate 只用 getView/onDidChange；返回空视图让 gate 停在缺省态即可。
  modelSelectionService: {
    getView: vi.fn(async () => null),
    onDidChange: vi.fn(() => ({ dispose: () => {} })),
  },
}));

// 本组隔离模式选择器的即时下发行为，群投递服务由独立单测及 Host/CLI E2E 覆盖。
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { zcodeInteractionBehavior: "guide" },
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: layerMock,
    sendCommand: sendCommandMock,
    attachmentPut: vi.fn(),
    // SessionPane 挂载即拉 journal 兜底的 run 发现查询：缺桩会在 effect 里 TypeError；
    // 桩必须是稳定引用——effect 以 workflowRuns 为依赖，每次渲染换新函数会死循环。
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: {} },
    draftConfigSeedSignal: 0,
    resolveInitialDraftConfig: vi.fn(),
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: Record<string, unknown>) => {
      composerProps.current = props;
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }),
  };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    // bottomDock 挂着 Composer（onSwitchMode 的真实挂载位置），必须渲染出来供本组测试触发。
    ConversationTimeline: ({ bottomDock }: { bottomDock?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-timeline" }, bottomDock),
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: () => React.createElement("div", { "data-testid": "mock-status" }),
  };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return {
    ConversationQueuePanel: () => React.createElement("div", { "data-testid": "mock-queue" }),
  };
});

vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return {
    V4InteractionDialogs: () => React.createElement("div", { "data-testid": "mock-interactions" }),
  };
});

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", async () => {
  const React = await import("react");
  return {
    V4ProviderRuntimeHeadersController: () =>
      React.createElement("div", { "data-testid": "mock-runtime-headers" }),
  };
});

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftEmptyState: () =>
      React.createElement("div", { "data-testid": "mock-draft-empty" }),
  };
});

// 草稿态推荐提示依赖 PlatformProvider；本组不测它，直接替换避免环境缺 Provider 击穿渲染。
vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftSuggestedPromptsContainer: () =>
      React.createElement("div", { "data-testid": "mock-draft-prompts" }),
  };
});

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    window: windowMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeSnapshot(mode: "build" | "yolo" = "build"): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function dispatchedModeSwitches() {
  return sendCommandMock.mock.calls.filter(
    ([command]) => command.type === "switchCollaborationMode",
  );
}

async function renderPane(sessionId: string | null) {
  const root = createRoot(installMinimalDom());
  await act(async () => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId,
          workspacePath: "/workspace",
        }),
      ),
    );
    await flushMicrotasks();
  });
  return root;
}

async function switchModeViaComposer(mode: string) {
  expect(composerProps.current).not.toBeNull();
  const onSwitchMode = composerProps.current!.onSwitchMode as (mode: string) => void;
  await act(async () => {
    onSwitchMode(mode);
    await flushMicrotasks();
  });
}

afterEach(() => {
  sendCommandMock.mockClear();
  projectionState.current = null;
  composerProps.current = null;
});

describe("SessionPane mode selector eager dispatch", () => {
  it("已有 Session 切换模式立即下发 switchCollaborationMode（CAS 带当前 revision）", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot("build"),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane("session-1");
    try {
      await switchModeViaComposer("yolo");
      const dispatched = dispatchedModeSwitches();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.[0]).toMatchObject({
        sessionId: "session-1",
        type: "switchCollaborationMode",
        payload: { mode: "yolo" },
        baseRevision: 7,
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("投影 mode 已是目标值时不重复下发", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot("yolo"),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane("session-1");
    try {
      await switchModeViaComposer("yolo");
      expect(dispatchedModeSwitches()).toHaveLength(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it.each(["plan", "plan-off"])("Plan 开关（%s）不下发 switchCollaborationMode", async (mode) => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot("build"),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane("session-1");
    try {
      await switchModeViaComposer(mode);
      expect(dispatchedModeSwitches()).toHaveLength(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("新增任务草稿（无 Session）只更新草稿，不即时下发", async () => {
    // 草稿态投影是 closed（hook 永不返回 null），不能把 mock 置成 null 击穿渲染。
    projectionState.current = {
      status: "closed",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane(null);
    try {
      await switchModeViaComposer("yolo");
      expect(dispatchedModeSwitches()).toHaveLength(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
