import { describe, expect, it, vi } from "vitest";
import { ServiceCollection, IZCodeAgentService, type IBotsService } from "@zcode/services";
import { createWindowTopicResourceRelay } from "../src/host/windowTopicResourceRelay.js";

const request = {
  requestId: "r",
  taskId: "t",
  inputId: "i",
  authorizationId: "a",
  messageId: "m",
  resourceIndex: 0,
  workspacePath: "/work",
  workspaceIdentity: "ssh://host/work",
  remoteSessionId: "remote",
};
describe("window topic resource authority", () => {
  it("binds channel sends to the physical remote connection", async () => {
    const peer = new ServiceCollection().register(IZCodeAgentService, {} as never);
    const other = new ServiceCollection().register(IZCodeAgentService, {} as never);
    let current = peer;
    const reply = vi.fn(async () => ({
      status: "sent",
      deliveryId: "d",
      providerMessageId: "om_sent",
    }));
    const relay = createWindowTopicResourceRelay({
      getPeerAgentService: () => peer.get(IZCodeAgentService),
      resolveServices: () => current,
      getBots: () =>
        ({
          readTopicResource: vi.fn(),
          validateTopicResource: vi.fn(),
          replyToChannel: reply,
        }) as unknown as IBotsService,
    });
    const value = {
      taskId: "t",
      inputId: "i",
      authorizationId: "a",
      toolCallId: "call",
      parts: [{ type: "mention", refId: "m1" }],
      workspacePath: "/work",
      workspaceIdentity: "ssh://host/work",
      remoteSessionId: "remote",
      trace: { traceId: "trace" },
    };
    // 修复依据：上游 v3.17.2 停用了 windowTopicResourceRelay 的默认 reply 接线
    // （渠道工具等待插件入口接入，实现保留但 deps.reply 不再传入），因此 reply 命令
    // 现在统一在通道层抛 "Channel reply unavailable"，无论连接是否匹配都不会触达 Bot。
    await expect(relay.channel.call("host", "reply", value)).rejects.toThrow(
      "Channel reply unavailable",
    );
    expect(reply).not.toHaveBeenCalled();
    current = other;
    await expect(relay.channel.call("host", "reply", value)).rejects.toThrow(
      "Channel reply unavailable",
    );
    expect(reply).not.toHaveBeenCalled();
    relay.dispose();
  });
  it("rejects a request resolved to another remote connection before Bot IO", async () => {
    const read = vi.fn();
    const validate = vi.fn();
    const peer = new ServiceCollection().register(IZCodeAgentService, {} as never);
    const other = new ServiceCollection().register(IZCodeAgentService, {} as never);
    const relay = createWindowTopicResourceRelay({
      getPeerAgentService: () => peer.get(IZCodeAgentService),
      resolveServices: () => other,
      getBots: () =>
        ({
          readTopicResource: read,
          validateTopicResource: validate,
        }) as unknown as IBotsService,
    });
    await expect(relay.channel.call("host", "begin", request)).rejects.toThrow("connection");
    expect(read).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    relay.dispose();
  });
  it("uses the current logical session and rechecks it after download", async () => {
    const peer = new ServiceCollection().register(IZCodeAgentService, {} as never);
    let online = true;
    const resolve = vi.fn(() => {
      if (!online) throw new Error("Disconnected");
      return peer;
    });
    const relay = createWindowTopicResourceRelay({
      getPeerAgentService: () => peer.get(IZCodeAgentService),
      resolveServices: resolve,
      getBots: () =>
        ({
          validateTopicResource: async () => undefined,
          readTopicResource: async () => {
            online = false;
            return {
              kind: "file",
              filename: "a.txt",
              mimeType: "text/plain",
              dataBase64: "aGk=",
            };
          },
        }) as unknown as IBotsService,
    });
    await expect(relay.channel.call("host", "begin", request)).rejects.toThrow("Disconnected");
    expect(resolve).toHaveBeenCalledWith({
      kind: "remote",
      remoteSessionId: "remote",
      workspaceIdentity: "ssh://host/work",
      workspacePath: "/work",
    });
    relay.dispose();
  });
});
