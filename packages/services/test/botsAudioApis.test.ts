import { describe, expect, it } from "vitest";
import {
  readBotSttConfig,
  transcribeAudioAttachment,
} from "../src/bots/audioTranscription.js";
import { readBotTtsConfig, synthesizeSpeech } from "../src/bots/audioSpeech.js";
import { taskStatusIcon } from "../src/bots/statusFormatting.js";

describe("bot STT config", () => {
  it("returns null unless all required variables are set", () => {
    expect(readBotSttConfig({})).toBeNull();
    expect(
      readBotSttConfig({
        ZCODE_BOT_STT_BASE_URL: "https://stt.local/v1",
        ZCODE_BOT_STT_API_KEY: "key",
      }),
    ).toBeNull();
  });

  it("normalizes base url and keeps optional language", () => {
    expect(
      readBotSttConfig({
        ZCODE_BOT_STT_BASE_URL: "https://stt.local/v1/",
        ZCODE_BOT_STT_API_KEY: "key",
        ZCODE_BOT_STT_MODEL: "whisper-1",
        ZCODE_BOT_STT_LANGUAGE: "en",
      }),
    ).toEqual({
      baseUrl: "https://stt.local/v1",
      apiKey: "key",
      model: "whisper-1",
      language: "en",
    });
  });
});

describe("bot STT transcription", () => {
  it("posts multipart form to the transcriptions endpoint and returns text", async () => {
    const fetchMock = async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://stt.local/v1/audio/transcriptions");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.authorization).toBe("Bearer key");
      const form = init?.body;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get("model")).toBe("whisper-1");
      expect(form.get("language")).toBe("en");
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("telegram-voice.ogg");
      return new Response(JSON.stringify({ text: "  hello world  " }), { status: 200 });
    };
    const result = await transcribeAudioAttachment(
      { baseUrl: "https://stt.local/v1", apiKey: "key", model: "whisper-1", language: "en" },
      {
        data: new Uint8Array([1, 2, 3]),
        attachment: { filename: "telegram-voice.ogg", mimeType: "audio/ogg" },
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toBe("hello world");
  });

  it("returns null on non-ok responses", async () => {
    const result = await transcribeAudioAttachment(
      { baseUrl: "https://stt.local/v1", apiKey: "key", model: "whisper-1" },
      {
        data: new Uint8Array([1]),
        attachment: { filename: "a.ogg", mimeType: "audio/ogg" },
      },
      (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    );
    expect(result).toBeNull();
  });
});

describe("bot TTS config", () => {
  it("returns null unless all required variables are set", () => {
    expect(readBotTtsConfig({})).toBeNull();
    expect(
      readBotTtsConfig({
        ZCODE_BOT_TTS_BASE_URL: "https://tts.local/v1",
        ZCODE_BOT_TTS_API_KEY: "key",
        ZCODE_BOT_TTS_MODEL: "tts-1",
      }),
    ).toBeNull();
  });

  it("defaults the format to opus and normalizes the base url", () => {
    expect(
      readBotTtsConfig({
        ZCODE_BOT_TTS_BASE_URL: "https://tts.local/v1/",
        ZCODE_BOT_TTS_API_KEY: "key",
        ZCODE_BOT_TTS_MODEL: "tts-1",
        ZCODE_BOT_TTS_VOICE: "alloy",
      }),
    ).toEqual({
      baseUrl: "https://tts.local/v1",
      apiKey: "key",
      model: "tts-1",
      voice: "alloy",
      format: "opus",
    });
    expect(
      readBotTtsConfig({
        ZCODE_BOT_TTS_BASE_URL: "https://tts.local/v1",
        ZCODE_BOT_TTS_API_KEY: "key",
        ZCODE_BOT_TTS_MODEL: "tts-1",
        ZCODE_BOT_TTS_VOICE: "alloy",
        ZCODE_BOT_TTS_FORMAT: "mp3",
      })?.format,
    ).toBe("mp3");
  });
});

describe("bot TTS synthesis", () => {
  it("posts json to the speech endpoint and returns audio bytes", async () => {
    const fetchMock = async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://tts.local/v1/audio/speech");
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body).toEqual({
        model: "tts-1",
        voice: "alloy",
        input: "done",
        response_format: "opus",
      });
      return new Response(new Uint8Array([9, 9]).buffer as ArrayBuffer, { status: 200 });
    };
    const result = await synthesizeSpeech(
      {
        baseUrl: "https://tts.local/v1",
        apiKey: "key",
        model: "tts-1",
        voice: "alloy",
        format: "opus",
      },
      "done",
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toEqual(new Uint8Array([9, 9]));
  });

  it("truncates long input and returns null on failure or empty text", async () => {
    const longText = "x".repeat(5000);
    const fetchMock = async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      expect(body.input.length).toBe(4000);
      return new Response(new Uint8Array([1]).buffer as ArrayBuffer, { status: 200 });
    };
    await synthesizeSpeech(
      {
        baseUrl: "https://tts.local/v1",
        apiKey: "key",
        model: "tts-1",
        voice: "alloy",
        format: "opus",
      },
      longText,
      fetchMock as unknown as typeof fetch,
    );
    const failed = await synthesizeSpeech(
      {
        baseUrl: "https://tts.local/v1",
        apiKey: "key",
        model: "tts-1",
        voice: "alloy",
        format: "opus",
      },
      "text",
      (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    );
    expect(failed).toBeNull();
  });
});

describe("task status icons", () => {
  it("maps runtime and persisted statuses", () => {
    expect(taskStatusIcon("streaming")).toBe("🟢");
    expect(taskStatusIcon("creating")).toBe("🟢");
    expect(taskStatusIcon("running")).toBe("🟢");
    expect(taskStatusIcon("completed")).toBe("✅");
    expect(taskStatusIcon("failed")).toBe("❌");
    expect(taskStatusIcon("persisted-error")).toBe("❌");
    expect(taskStatusIcon("idle")).toBe("⚪");
    expect(taskStatusIcon("whatever")).toBe("⚪");
  });
});
