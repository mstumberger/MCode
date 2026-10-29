/**
 * Bot 语音转文字。通过 OpenAI 兼容的 /audio/transcriptions 端点接入任意 STT 后端
 * （OpenAI、Groq、LocalAI、faster-whisper-server 等），由环境变量显式配置；
 * 未配置时保持原有行为（音频只作为附件透传给模型）。
 */
import type { BotInboundAttachment } from "@zcode/shared";

// Bugfix：CPU 上 large-v3 转写远慢于实时（~43s 音频需要 30-60s+），30s 超时
// 会让较长的语音消息全部中止并静默降级为纯附件。放宽到 5 分钟与 TTS 对齐。
const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 300_000;

export interface BotSttConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
}

type EnvLike = Record<string, string | undefined>;

export function readBotSttConfig(env: EnvLike): BotSttConfig | null {
  const baseUrl = env.ZCODE_BOT_STT_BASE_URL?.trim();
  const apiKey = env.ZCODE_BOT_STT_API_KEY?.trim();
  const model = env.ZCODE_BOT_STT_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) {
    return null;
  }
  const language = env.ZCODE_BOT_STT_LANGUAGE?.trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    apiKey,
    model,
    ...(language ? { language } : {}),
  };
}

export async function transcribeAudioAttachment(
  config: BotSttConfig,
  input: {
    data: Uint8Array;
    attachment: Pick<BotInboundAttachment, "filename" | "mimeType">;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const form = new FormData();
  // BlobPart 需要 ArrayBuffer 支撑的视图；复制一次以摆脱 SharedArrayBuffer 兼容类型。
  const audioBytes = new Uint8Array(input.data);
  form.append(
    "file",
    new Blob([audioBytes], { type: input.attachment.mimeType }),
    input.attachment.filename,
  );
  form.append("model", config.model);
  if (config.language) {
    form.append("language", config.language);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIO_TRANSCRIPTION_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { text?: unknown };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return text || null;
  } finally {
    clearTimeout(timeout);
  }
}
