import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";

describe("ZCodeAgentService workspace Hook Trust", () => {
  it("没有 task/provider 时只启动 read-only Agent 并发送 workspace grant", async () => {
    const request = vi.fn(async (method: string) => {
      // 修复依据：上游 v3.17.2 起 client 启动先发 runtime/capabilities 协商；
      // mock 需按空能力集应答（全字段可选）。
      if (method === zcodeProtocolMethods.runtimeCapabilities) {
        return {};
      }
      if (method === zcodeProtocolMethods.workspaceHookTrustGrant) {
        return { accepted: true };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const getClient = vi.fn(async () => ({
      request,
      transportKind: "stdio" as const,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    }));
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class {
        getClient = getClient;
        // 修复依据：上游 v3.17.2 起只读 client 启动会调用 isSharedRuntime 判定
        // sessionWorkspaceRouting 协商失败是否致命；mock 需补齐该方法。
        isSharedRuntime() {
          return false;
        }
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import(
      "../src/zcode-agent/zcodeAgentService.js"
    );
    const service = createZCodeAgentService();

    await expect(
      service.grantWorkspaceHookTrust({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:host:/repo",
        remoteSessionId: "remote-session-1",
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      }),
    ).resolves.toEqual({ accepted: true });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workspaceHookTrustGrant,
      {
        workspace: {
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:host:/repo",
          remoteSessionId: "remote-session-1",
          workspaceKey: "remote:ssh:host:/repo",
        },
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      },
      expect.anything(),
    );
    service.disposeAll();
  });
});
