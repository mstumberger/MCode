/**
 * Bot 语音摘要（TTS）。通过 OpenAI 兼容的 /audio/speech 端点合成音频，
 * 默认请求 opus（OGG/Opus 容器）以匹配 Telegram sendVoice 的要求。
 * 未配置时任务完成只发文本，行为不变。
 */
const SPEECH_TIMEOUT_MS = 30_000;
const SPEECH_INPUT_MAX_CHARS = 4000;

export interface BotTtsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "opus" | "mp3" | "aac";
}

type EnvLike = Record<string, string | undefined>;

export function readBotTtsConfig(env: EnvLike): BotTtsConfig | null {
  const baseUrl = env.ZCODE_BOT_TTS_BASE_URL?.trim();
  const apiKey = env.ZCODE_BOT_TTS_API_KEY?.trim();
  const model = env.ZCODE_BOT_TTS_MODEL?.trim();
  const voice = env.ZCODE_BOT_TTS_VOICE?.trim();
  if (!baseUrl || !apiKey || !model || !voice) {
    return null;
  }
  const rawFormat = env.ZCODE_BOT_TTS_FORMAT?.trim();
  const format: BotTtsConfig["format"] =
    rawFormat === "mp3" || rawFormat === "aac" ? rawFormat : "opus";
  return {
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    apiKey,
    model,
    voice,
    format,
  };
}

export async function synthesizeSpeech(
  config: BotTtsConfig,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array | null> {
  const input = text.trim().slice(0, SPEECH_INPUT_MAX_CHARS);
  if (!input) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        voice: config.voice,
        input,
        response_format: config.format,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
