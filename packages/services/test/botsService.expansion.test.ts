import { describe, expect, it, vi } from "vitest";
import type { BotsConfigFile } from "@zcode/shared";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

const weixinActor = {
  provider: "weixin" as const,
  botId: "weixin-1",
  providerUserId: "wx_user",
  chatType: "private" as const,
};

const customCommandConfig: BotsConfigFile = {
  ...f.baseConfig,
  bots: [
    {
      ...f.baseConfig.bots[0]!,
      customCommands: [
        {
          name: "deploy",
          description: "Deploy the current project",
          prompt: "Deploy the current project.",
        },
      ],
    },
  ],
};

async function bind(service: ReturnType<typeof f.createBotsService>) {
  const code = await service.createBindCode({ botId: "webhook-1" });
  await service.handleInboundMessage({
    botId: "webhook-1",
    text: `/bind ${code.code}`,
    actor,
  });
}

describe("custom bot commands", () => {
  it("expands a configured custom command into a prompt with trailing text", async () => {
    vi.stubEnv("ZCODE_DATA_BASE_DIR", `/tmp/zcode-bot-custom-${Date.now()}`);
    const repo = f.createMemoryRepo(customCommandConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/deploy staging now",
      actor,
    });

    expect(replies).toEqual([]);
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Deploy the current project.\n\nstaging now",
      }),
    );
    service.disposeAll();
  });

  it("still rejects unknown commands that are not configured", async () => {
    vi.stubEnv("ZCODE_DATA_BASE_DIR", `/tmp/zcode-bot-custom-${Date.now()}`);
    const repo = f.createMemoryRepo(customCommandConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/wat",
      actor,
    });

    expect(legacyTaskService.sendPrompt).not.toHaveBeenCalled();
    expect(replies[0]?.text).toContain("未知命令");
    service.disposeAll();
  });
});

describe("voice transcription", () => {
  it("uses the STT transcript as the prompt for voice-only messages", async () => {
    vi.stubEnv("ZCODE_DATA_BASE_DIR", `/tmp/zcode-bot-stt-${Date.now()}`);
    vi.stubEnv("ZCODE_BOT_STT_BASE_URL", "https://stt.test/v1");
    vi.stubEnv("ZCODE_BOT_STT_API_KEY", "key");
    vi.stubEnv("ZCODE_BOT_STT_MODEL", "whisper-1");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "hello from voice" })));
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);

    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "",
      attachments: [
        {
          id: "voice-1",
          kind: "audio",
          filename: "telegram-voice.ogg",
          mimeType: "audio/ogg",
          dataBase64: "AQID",
        },
      ],
      actor,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://stt.test/v1/audio/transcriptions");
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("hello from voice"),
        attachments: [
          expect.objectContaining({ kind: "audio", filename: "telegram-voice.ogg" }),
        ],
      }),
    );
    service.disposeAll();
  });

  it("appends a transcript line when the voice message also has text", async () => {
    vi.stubEnv("ZCODE_DATA_BASE_DIR", `/tmp/zcode-bot-stt-${Date.now()}`);
    vi.stubEnv("ZCODE_BOT_STT_BASE_URL", "https://stt.test/v1");
    vi.stubEnv("ZCODE_BOT_STT_API_KEY", "key");
    vi.stubEnv("ZCODE_BOT_STT_MODEL", "whisper-1");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ text: "hello again" })));
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);

    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "summarize it",
      attachments: [
        {
          id: "voice-1",
          kind: "audio",
          filename: "telegram-voice.ogg",
          mimeType: "audio/ogg",
          dataBase64: "AQID",
        },
      ],
      actor,
    });

    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("语音转写：hello again"),
      }),
    );
    service.disposeAll();
  });
});

describe("read-only task list while running", () => {
  it("lists tasks with status icons instead of refusing when the active task runs", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig);
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        status: "streaming",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
        provider: "glm",
      },
      {
        taskId: "task-2",
        title: "Finished task",
        status: "completed",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
        provider: "glm",
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "run task",
      actor: weixinActor,
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/task",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("任务列表（只读");
    expect(replies[0]?.text).toContain("🟢 Active task");
    expect(replies[0]?.text).toContain("· current");
    expect(replies[0]?.text).toContain("✅ Finished task");
    expect(replies[0]?.text).toContain("当前任务正在运行");
    expect(replies[0]).not.toHaveProperty("selection");
    service.disposeAll();
  });
});
