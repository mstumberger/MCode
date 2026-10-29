# Bot Voice Transcription (STT) and Voice Summary (TTS) via local VoiceStudio

Telegram voice messages arrive as OGG/Opus attachments. The bots service can transcribe them to text before the message reaches the model, so voice notes work like normal text input. When a task finishes, the bot can also synthesize a voice summary reply. Both are backed by a self-hosted [VoiceStudio](https://github.com/debpalash/VoiceStudio) Docker container exposing OpenAI-compatible endpoints.

## Wiring overview

```text
Telegram voice note (.ogg/Opus)
  → telegramProvider.ts parses attachment "telegram-voice.ogg" (audio/ogg)
  → botsService.ts transcribeVoiceAttachment()
      reads ZCODE_BOT_STT_* from process.env via readBotSttConfig()
  → POST http://127.0.0.1:3900/v1/audio/transcriptions
      multipart: file=<original .ogg bytes>, model=whisper-large-v3, language=sl
      Authorization: Bearer <OMNIVOICE_API_KEY>
  → VoiceStudio container (name: omnivoice)
      engine faster-whisper, model Systran/faster-whisper-large-v3
  → response { "text": "..." } injected into the inbound message
```

Code entry points:

- `packages/services/src/bots/audioTranscription.ts` - env config (`readBotSttConfig`) and the HTTP call (`transcribeAudioAttachment`). All three `ZCODE_BOT_STT_*` values are required or transcription is silently skipped and audio passes through as a plain attachment.
- `packages/services/src/bots/botsService.ts` - calls transcription per inbound audio attachment; 300 s hard timeout (`AUDIO_TRANSCRIPTION_TIMEOUT_MS`) on the fetch.
- `packages/services/src/bots/providers/telegramProvider.ts` - produces the `telegram-voice.ogg` attachment and downloads it via `getFile`.

### TTS (voice summary reply)

```text
task completes
  → botsService.ts sendCompletionVoiceSummary()
      requires bot.voiceSummary === true, provider === telegram,
      and readBotTtsConfig(process.env) with all four ZCODE_BOT_TTS_* values
  → POST http://127.0.0.1:3900/v1/audio/speech
      JSON: { model: "tts-1", voice: "alloy", input: <summary text ≤4000 chars>,
              response_format: "opus" }
      Authorization: Bearer <OMNIVOICE_API_KEY>
  → VoiceStudio container, engine omnivoice, model k2-fsa/OmniVoice
  → binary OGG/Opus → telegramProvider sendVoice() (Telegram voice note,
      caption "Task summary (voice)")
```

Code entry points: `packages/services/src/bots/audioSpeech.ts` (`readBotTtsConfig`, `synthesizeSpeech`, 300 s timeout, 4000-char cap), `packages/services/src/bots/botsService.ts` (`sendCompletionVoiceSummary`), `telegramProvider.ts` `sendVoice` (falls back to plain text when voice delivery fails). The per-bot flag `voiceSummary: true` in `bot-config.v3.json` is opt-in and required.

Two bugfixes are part of this wiring (keep them when evolving the feature):

- **Empty summary input**: in the default `assistant_changes` reply mode the reply text is streamed during the turn, so `replyMessages` is empty at completion; the voice summary must fall back to the turn's streamed assistant content or it receives an empty string and silently skips (`botsService.ts`, `streamedAssistantText` fallback).
- **Observability**: every skip and failure path of `sendCompletionVoiceSummary` logs a `botsLogger.warn` line (`voice summary guard rejected`, `voice summary skipped: TTS backend not configured`, `voice summary synthesis failed`, `voice summary skipped: empty synthesis result`), mirroring the STT path's `voice transcription failed` warn. Without these the pipeline fails invisibly.

## Bot-side configuration

Lives in `.env.local` at the repo root (gitignored; never commit the API key):

```dotenv
ZCODE_BOT_STT_BASE_URL=http://127.0.0.1:3900/v1
ZCODE_BOT_STT_API_KEY=<OMNIVOICE_API_KEY, same key as the container>
ZCODE_BOT_STT_MODEL=whisper-large-v3
ZCODE_BOT_STT_LANGUAGE=sl
```

- The base URL must NOT include `/audio/transcriptions`; the code appends it.
- `ZCODE_BOT_STT_LANGUAGE` uses ISO-639-1 codes (`sl`, not `Slovenian`); without it, language autodetect on short Slovenian clips frequently misdetects (observed: Romanian/Finnish on a 3 s clip).
- Desktop loads `.env.local` at startup via `packages/desktop/src/main/desktopRuntimeEnv.ts` (`loadHostProcessEnvFromLocalFiles`) and passes it to the services node process. **Changing these vars requires a desktop app restart**; the running bot does not hot-reload them.
- `ZCODE_BOT_STT_LANGUAGE` omission falls back to Whisper autodetect - only do this for multilingual traffic.

TTS configuration (same file):

```dotenv
ZCODE_BOT_TTS_BASE_URL=http://127.0.0.1:3900/v1
ZCODE_BOT_TTS_API_KEY=<same OMNIVOICE_API_KEY>
ZCODE_BOT_TTS_MODEL=tts-1
ZCODE_BOT_TTS_VOICE=alloy
ZCODE_BOT_TTS_FORMAT=opus
```

- All four non-format vars are required or the voice summary is silently skipped.
- `voice`: OpenAI alias names (`alloy`, `nova`, ...) and `default` resolve to the OmniVoice engine default voice; a custom/cloned voice uses its VoiceStudio voice-profile id or unique name instead.
- `format` must stay `opus` for Telegram voice bubbles.
- The bot must ALSO have `voiceSummary: true` in its `bot-config.v3.json` entry (opt-in, default off).

## Recreating the container from scratch

Run on the Docker host (this machine). Requires ~6.5 GB disk (image + model volume) and ~4 GB RAM for the resident model.

```bash
# 1. Generate an API key (keep it; it goes into .env.local too)
export OMNIVOICE_API_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"

# 2. Run the container (CPU image; loopback-only; auto-restarts on boot).
#    OMNIVOICE_IDLE_TIMEOUT=604800 keeps models resident: the default 900 s idle
#    unload forces a cold reload on the next request that can exceed the bots'
#    30 s STT timeout (observed stuck reload > 60 s). Resident cost ~4 GB RAM.
#    Licence acceptance does NOT survive container recreation - re-run the
#    licence accept loop below after every `docker rm -f` + run.
docker run -d --name omnivoice --restart unless-stopped \
  -p 127.0.0.1:3900:3900 \
  -e OMNIVOICE_API_KEY="$OMNIVOICE_API_KEY" \
  -e OMNIVOICE_ANALYTICS_DISABLED=1 \
  -e OMNIVOICE_IDLE_TIMEOUT=604800 \
  -v omnivoice-data:/app/omnivoice_data \
  ghcr.io/debpalash/voicestudio:stable

# 3. Wait for health (first boot takes a few seconds)
curl -s http://127.0.0.1:3900/health
# -> {"status":"ok","device":"cpu","version":"0.5.7"}

# 4. Install the ASR model (~2.9 GB download into the omnivoice-data volume)
KEY="$OMNIVOICE_API_KEY"
curl -s -X POST http://127.0.0.1:3900/models/install \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"repo_id":"Systran/faster-whisper-large-v3","target":"local"}'
# -> {"status":"install_started",...}
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:3900/models/install/status
# poll until "jobs" is empty, then confirm via:
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:3900/models | \
  python3 -c "import json,sys; [print(m['repo_id'], m['installed']) for m in json.load(sys.stdin)['models'] if m['role']=='ASR']"

# 5. Smoke-test transcription with a real voice note
curl -s -X POST http://127.0.0.1:3900/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F "file=@telegram-voice.ogg;type=audio/ogg" \
  -F "model=whisper-large-v3" -F "language=sl"
# -> {"text":"..."}

# 6. Write the four ZCODE_BOT_STT_* vars into .env.local (see above), then restart the desktop app.
```

### TTS model setup (k2-fsa/OmniVoice)

The TTS engine needs a one-time licence acceptance plus a ~3.1 GB download. The `eustlb/higgs-audio-v2-tokenizer` licence term is accepted through the same flow even though the tokenizer is not in the install catalogue (it ships as a dependency).

```bash
KEY="$OMNIVOICE_API_KEY"

# 1. Accept licences (fetch current fingerprint, then accept) for BOTH repos:
for R in k2-fsa/OmniVoice eustlb/higgs-audio-v2-tokenizer; do
  FP=$(curl -s -H "Authorization: Bearer $KEY" \
    "http://127.0.0.1:3900/models/licenses/details/$R" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['acceptance']['fingerprint'])")
  curl -s -X POST http://127.0.0.1:3900/models/licenses/accept \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"repo_id\":\"$R\",\"fingerprint\":\"$FP\",\"accepted\":true}"
done

# 2. Install the model (licence for the tokenizer is accepted as part of the flow above):
curl -s -X POST http://127.0.0.1:3900/models/install \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"repo_id":"k2-fsa/OmniVoice","target":"local"}'
# poll /models/install/status until jobs are empty

# 3. Smoke-test Slovenian synthesis (expect Ogg Opus bytes):
curl -s -X POST http://127.0.0.1:3900/v1/audio/speech \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"tts-1","voice":"alloy","input":"Pozdravljen.","response_format":"opus"}' \
  -o /tmp/tts.ogg && file /tmp/tts.ogg

# 4. Add ZCODE_BOT_TTS_* to .env.local, set voiceSummary: true on the bot
#    in bot-config.v3.json, restart the desktop app.
```

Licence note: OmniVoice weights are **CC-BY-NC (non-commercial)** plus Higgs Audio 2 / Meta Llama 3 tokenizer terms - fine for personal/private bots, not for commercial use.

## Key recovery and rotation

The key exists in exactly two places: the container's `OMNIVOICE_API_KEY` env and `ZCODE_BOT_STT_API_KEY` in `.env.local`. To recover a lost `.env.local` value from the running container:

```bash
docker inspect omnivoice --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^OMNIVOICE_API_KEY='
```

To rotate: recreate the container with a new key (or `docker rm -f omnivoice` then the run command above; the `omnivoice-data` volume keeps the downloaded model) and update `.env.local`, then restart the desktop app.

## Constraints and known limits

- **GPU active (RTX 3060).** NVIDIA Container Toolkit is installed; the container runs with GPU access (`--gpus all`, `DeviceRequests: Count=-1`). Synthesis takes ~3 s for a sentence (was 42-48 s on CPU), transcription is effectively instant. When recreating the container, add `--gpus all` to the `docker run` command. History: GPU was initially skipped because installing the toolkit requires a Docker daemon restart - that restart bounces every running container, but all containers on this host use the `unless-stopped` policy and auto-recover within a minute.
- **Client timeouts are 300 s in the bots feature code** (`AUDIO_TRANSCRIPTION_TIMEOUT_MS` in `audioTranscription.ts`, `SPEECH_TIMEOUT_MS` in `audioSpeech.ts`). They were 30 s originally, which aborted every synthesis slower than realtime and every voice note longer than ~15 s of audio on CPU - the root cause of "no voice reply ever arrives". On GPU both are generous.
- **Known open bug - automated completion voice summary**: `task_complete` events never reach the bot runtime's stream handler (`handleStreamEventImpl`), while `agent_message_chunk` events (text streaming) do. Symptom: text replies deliver, but `sendCompletionVoiceSummary` never runs - zero log lines, including the guard log (`voice summary guard rejected: ...`) that logs on every guard rejection. Debug entry point: breakpoint the stream subscription ingress into `botsService.ts` and compare which event types arrive on the bot host. Note the runtime topology: the bot runtime host is spawned as a child of the session/task host - verify terminal events mirror across that boundary. The direct delivery path (synthesize + Telegram `sendVoice` with the bot token) is proven working and serves as a fallback.
- **Instance-stacking pitfall (BotDev)**: the relaunch script's `pkill` patterns do not match the renamed `ZCode BotDev` main process title, so every relaunch leaves the previous instance alive. Stale instances keep winning the Telegram long-poll race and run old builds, which makes fixes appear to "not work". Kill stale `ZCode BotDev` mains before relaunching (or fix the script's pattern). Also: a `pkill -f` pattern that appears literally in the killing script's own command line kills the script itself - build the pattern with string concatenation.
- **Wedge failure mode (historical, mostly CPU-era)**: piled-up client-side aborts can stall the ASR queue with the CPU spinning until `docker restart omnivoice`. A watchdog automation (every 10 min: STT probe → restart on wedge, log in `/tmp/omnivoice-watchdog.log`) self-heals this.
- **Licence persistence**: model licence acceptance survives `docker restart` but is lost on container recreation (`docker rm` + `run`) - re-run the licence accept loop from the TTS setup section after recreating.
- **Model stays resident**: ~3.8 GB RAM while the container runs. Model files live in the `omnivoice-data` Docker volume and survive container recreation.
- **Port binding is loopback-only** (`127.0.0.1:3900`). The bots service runs on the host, so this works; do not expose the port externally without revisiting auth.
- **OGG/Opus is accepted natively** - no Telegram-to-wav/mp3 conversion is needed (this is why z.ai's GLM-ASR API, which only accepts .wav/.mp3, was not used).
- VoiceStudio updates: `docker pull ghcr.io/debpalash/voicestudio:stable` then recreate the container; the model volume is preserved.
- UI is also served at http://127.0.0.1:3900 (Model Catalogue, engines) if you prefer clicking over curl for model management.
