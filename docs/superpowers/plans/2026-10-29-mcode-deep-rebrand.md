# MCode Deep Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deep-rename ZCode to MCode across display, packaging, env prefix, packages, bin, data dirs, IPC channels, and the renderer bridge - while every item on the spec's Preserve list keeps working (z.ai OAuth, stored credentials, wire protocol, plugin ecosystem, `zcode://` deep links).

**Architecture:** Each spec phase (P0-P6) ships as an independent, revertable commit. All mechanical replacements are codified into a deterministic replay script (`scripts/rebrand/apply-mcode.mjs`) whose whitelist equals the Preserve list; the script is both the implementation vehicle and the post-merge upstream tool. Transitions use dual-read (`MCODE_*` ?? `ZCODE_*`, `.mcode` ?? `.zcode`) so nothing breaks mid-sequence.

**Tech Stack:** TypeScript, pnpm monorepo, Electron 41, Node 24 (mise), vitest.

**Design Spec:** `docs/superpowers/specs/2026-10-29-mcode-deep-rebrand-design.md`

---

## File Structure (key files; mass renames are script-driven)

### New files
| File | Responsibility |
|---|---|
| `scripts/rebrand/apply-mcode.mjs` | Deterministic replayable rename layer (rules per phase + Preserve whitelist) |
| `scripts/rebrand/whitelist.mjs` | Preserve-list literals that must never be rewritten |
| `packages/services/src/test/pathsMigration.test.ts` | `~/.zcode → ~/.mcode` migration unit tests |
| `packages/services/src/test/credentialAlias.test.ts` | Old credential decrypts under `MCODE_CREDENTIAL_SECRET` alias |

### Modified files (central touchpoints per phase; full lists are the script's rule output)
| Phase | Files |
|---|---|
| P0 display | `packages/desktop/src/main/desktopRuntimeEnv.ts`, `about.ts`, `packages/shared/src/desktopMenu.ts`, `process-names.ts`, `plugin-display-name.ts`, `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`, ~8 hardcoded UI components, `packages/ui/src/lib/builtinSkillI18n.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `webAuthLocale.ts`, `webRemoteControlBrand.tsx`, `ConversationShareLandingPage.tsx`, `apps/zcode-cli/packages/tui/src/app-sidebar.tsx`, `apps/zcode-cli/packages/i18n/src/locales/*`, `apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts` |
| P1 packaging | `packages/desktop/scripts/desktop-product-identity.mjs`, `electron-builder.config.js`, `packages/desktop/package.json`, `desktopLinuxDeepLinkRegistration.ts`, `desktopDeepLinkUrl.ts`, icon assets |
| P2 env alias | env parse sites across `packages/services/src/paths.ts`, `apps/zcode-cli/packages/cli/src/env.ts`, `credentialCipherProvider.ts`, `credential-cipher.ts` + new shared `readEnv` helper |
| P3 migration | `packages/services/src/paths.ts` (+ CLI `env.ts`, `localUsageEvidence.ts`, `memoryService.ts`), `workspace-hook-trust.ts` |
| P4 packages | `pnpm-workspace.yaml`, all `package.json` names, import specifiers, dir renames `apps/zcode-cli`→`apps/mcode-cli`, `packages/zcode-*`→`packages/mcode-*`, lockfile regen |
| P5 IPC/bridge | `packages/shared/src/channels.ts`, invoke/listener call sites, `packages/desktop/src/preload/*`, renderer `window.zcode` consumers |

### Deleted files
| File |
|---|
| (none - no deletions; P6 later removes alias shims) |

---

## Task 1: Rebrand replay script skeleton + Preserve whitelist

**Files:**
- Create: `scripts/rebrand/apply-mcode.mjs`
- Create: `scripts/rebrand/whitelist.mjs`

- [ ] **Step 1: Create `whitelist.mjs`** exporting an array of protected literals (exact-match and regex forms): `zcode.z.ai`, `cdn-zcode.z.ai`, `/api/v1/zcode-plan`, `wss://zcode.z.ai`, `client_P8X5CMWmlaRO9gyO-KSqtg`, `zcode://oauth/callback`, `zcode-credential-fallback:`, `"ZCode Protocol"`, `zcode_official`, `zcode-plugins-official`, `x-zcode-intranet-token`, `x-zcode-rpc-client-mode`, `x-zcode-rpc-host-capability`, `zcode/errorPresentation`, `zcode/browserScreenshotContentIndices`, `zcode/nodeReplCuaApp`, `zcode/officialMcpServerRequestId`, `ZCODE_PROTOCOL_NAME`, `zcode:set_globals`, `zcode:globals`, `zcode:error` DOM event. Source of truth = spec Preserve list.
- [ ] **Step 2: Create `apply-mcode.mjs`**: file-walking rewriter over tracked files (respect `.git`), rule registry `{ id, phase, match, replace, globs, excludeWhitelist: false }`, `--phase P0..P5` and `--dry-run` flags. Before writing any replacement it asserts the touched span does not intersect a whitelist literal (throw on violation). Idempotent: running twice yields zero diff.
- [ ] **Step 3: Smoke-verify**: `node scripts/rebrand/apply-mcode.mjs --dry-run --phase P0` prints planned file counts; no repo changes.

**Verify:** `node scripts/rebrand/apply-mcode.mjs --dry-run` exits 0 on clean tree.

---

## Task 2 (P0): Desktop runtime + main-process display strings

**Files:**
- Modify: `packages/desktop/src/main/desktopRuntimeEnv.ts`, `about.ts`, `forceUpdateGuard.ts`, `forceUpdatePrompt.ts`, `desktopOAuthDeepLink.ts`, `desktopWindowsOpenFolderContextMenu.ts`, `desktopLinuxDeepLinkRegistration.ts`
- Modify: `packages/shared/src/desktopMenu.ts`, `process-names.ts`, `plugin-display-name.ts`, `openrouter-attribution.ts`
- Modify: `packages/desktop/src/renderer/index.html` (`<title>`)
- Modify: `packages/services/src/runtime-tools/appCaCert.ts`, `packages/services/src/paths.ts` (Program Files\ZCode detection keeps BOTH old and new)

- [ ] **Step 1:** Add P0 rules to the script for the single-point defaults: `desktopRuntimeEnv.ts` `"ZCode"→"MCode"`, `"ZCode Dev"→"MCode Dev"`, `"ZCode Preview"→"MCode Preview"`; `about.ts` `ABOUT_APPLICATION_NAME`; `desktopMenu.ts` tray/menu/about strings (en+zh); `process-names.ts` special-case title.
- [ ] **Step 2:** Add P0 rules for the distributed main-process dialogs (`forceUpdate*`, `desktopOAuthDeepLink`, Windows context menu "Open in ZCode"/"在ZCode中打开" → "Open in MCode"/"在MCode中打开"). Windows registry key `ZCode.OpenInZCode` gains `MCode.OpenInMCode` as an ADDITIONAL registration (old key untouched on upgraded machines).
- [ ] **Step 3:** Apply (`--phase P0 --glob` limited to the files above), then `git diff` review that no whitelist literal moved.
- [ ] **Step 4:** Update `Program Files` install-path detection in `paths.ts` to accept `Program Files\MCode` first, keep `Program Files\ZCode` fallback.

**Verify:** `pnpm typecheck && pnpm lint && pnpm --filter @zcode/desktop test src/` (affected); manual: launch dev app, tray/About/window title show MCode.

---

## Task 3 (P0): UI i18n + hardcoded components

**Files:**
- Modify: `packages/ui/src/i18n/locales/en-US.ts`, `zh-CN.ts`
- Modify: `packages/ui/src/WorkspaceSidebarFooter.tsx`, `WindowsTopLeftLogo.tsx`, `WelcomeScreen.tsx`, `onboarding/OnboardingWelcomeView.tsx`, `highspeed/HighspeedShareNoticeCard.tsx`, `lib/builtinSkillI18n.ts`, `lib/zcodeUiError.ts`
- Modify: `packages/ui/src/components/ui/ZCodeAboutLogo.tsx` (wordmark SVG paths), `components/mobile-ui/ZCodeAppLogo.tsx`, `root/RootStartupLoading.tsx`

- [ ] **Step 1:** Script rule: within the two locale files replace value strings `ZCode→MCode` (~124 hits each; keys untouched). Grep gate afterwards: `grep -n "ZCode" packages/ui/src/i18n/locales/*.ts` returns only intentional leftovers, each with an inline `// rebrand: keep` comment.
- [ ] **Step 2:** Hardcoded components: aria-labels, sidebar fallback name, error strings, builtin skill descriptions.
- [ ] **Step 3:** Wordmark: replace `ZCodeWordmarkLogo` SVG paths with M-code glyph + "MCode" lettering at identical viewBox; keep export names for now (component renames are cosmetic-followup, not blockers). Tray/app icons (`.ico/.icns/png`) are NOT redesigned here - tracked as follow-up design task in Task 15.

**Verify:** `pnpm --filter @zcode/ui typecheck`; visual smoke of WelcomeScreen, sidebar, About, skills UI.

---

## Task 4 (P0): Web + CLI/TUI + agent identity

**Files:**
- Modify: `packages/web/index.html`, `src/main.tsx`, `src/auth/webAuthLocale.ts`, `src/web-remote-control/ui/webRemoteControlBrand.tsx`, `webRemoteControlConnectionSheet.tsx`, `src/share/ConversationShareLandingPage.tsx`; `packages/web-share/index.html`, `src/main.tsx`
- Modify: `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` (`PRODUCT_NAME`), `apps/zcode-cli/packages/i18n/src/locales/*`, `apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts`, `core/src/subagent/explore.ts`, `core/src/runtime/methods/workspace-generate-text.ts`, `bootstrap/src/app/startup-marks.ts`, `create-app.ts`

- [ ] **Step 1:** Web surfaces per the map: titles, `brand` field, landing copy ("Download ZCode"→"Download MCode", zh+en).
- [ ] **Step 2:** CLI: TUI `PRODUCT_NAME`, i18n help/banners, startup marks.
- [ ] **Step 3:** Agent prompts: `"You are ZCode, an interactive coding agent"` → `"You are MCode, ..."`; subagent Explore prompt likewise. (Pure prompt text; tool names/protocol untouched.)
- [ ] **Step 4:** Commit P0 as ONE commit (`rebrand(P0): display name MCode`).

**Verify:** `pnpm typecheck && pnpm lint`; `pnpm --filter @zcode/web build`; grep gate `rg -n "ZCode" packages/ui/src packages/web/src apps/zcode-cli/packages/{tui,i18n}` only whitelisted-commented lines.

---

## Task 5 (P1): Packaging identity

**Files:**
- Modify: `packages/desktop/scripts/desktop-product-identity.mjs`, `electron-builder.config.js`, `package.json`
- Modify: `packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts`

- [ ] **Step 1:** `PRODUCTION_IDENTITY = { appId: "dev.mcode.app", productName: "MCode", linuxExecutableName: "mcode", linuxPackageName: "mcode" }`; preview/dev identities likewise (`MCode Preview`, `dev.mcode.app.preview`, AppUserModelId `si.stumberger.mcode`).
- [ ] **Step 2:** electron-builder: author `MCode`, homepage/maintainer → `https://github.com/mstumberger/MCode`; artifact templates inherit productName; Linux desktop `Icon=mcode`; `afterPack` hooks referencing icon filenames updated.
- [ ] **Step 3:** `package.json` `productName`, `description`.
- [ ] **Step 4:** Commit P1 (`rebrand(P1): packaging identity`).

**Verify:** `pnpm --filter @zcode/desktop dist:linux` produces `MCode-<version>` artifacts; installed `.desktop` shows Name=MCode, Icon=mcode; `pnpm typecheck`.

---

## Task 6 (P1): `mcode://` deep link alongside `zcode://`

**Files:**
- Modify: `electron-builder.config.js` (protocols), `packages/desktop/src/main/desktopDeepLinkUrl.ts`, `desktopLinuxDeepLinkRegistration.ts`, `desktopOAuthDeepLink.ts`

- [ ] **Step 1:** Register BOTH schemes (`zcode`, `mcode`) in electron-builder `protocols.schemes` and the Linux desktop entry (`MimeType=x-scheme-handler/mcode;x-scheme-handler/zcode;`).
- [ ] **Step 2:** URL parser accepts both prefixes; OAuth callback matching still keyed on `zcode://oauth/callback` (Preserve) AND accepts `mcode://oauth/callback` for future server-side registration (client_id unchanged).
- [ ] **Step 3:** Commit P1b (`rebrand(P1): dual deep-link scheme`).

**Verify:** `mcode://workspace/open?...` and `zcode://workspace/open?...` both focus an existing instance in a dev run; unit tests for the URL parser both schemes.

---

## Task 7 (P2): `MCODE_*` env dual-read

**Files:**
- Create: `packages/shared/src/envAlias.ts` (`readEnv(env, base)` resolving `MCODE_<X> ?? ZCODE_<X>`)
- Modify: env parse sites surfaced by `rg -n "ZCODE_[A-Z_]+" packages apps --type ts -l` (primary: `paths.ts`, `cli/src/env.ts`, `credentialCipherProvider.ts`, `credential-cipher.ts`, `localUsageEvidence.ts`, `memoryService.ts`, `zcodeAgentProcessManager.ts`, `desktopRuntimeEnv.ts`, `botsService` STT/TTS readers)
- Modify: `.env.example`, docs referencing env keys, `scripts/` helpers

- [ ] **Step 1:** Implement `readEnv` helper with unit tests (alias matrix: only-new, only-legacy, both→new wins, neither→undefined).
- [ ] **Step 2:** Convert persistence-critical parse sites first (credential secret, data dirs, storage, session DB), then the rest grep-driven. Behavior: read via alias, write/generate `MCODE_*` only.
- [ ] **Step 3:** Credential secret: `readEnv(env, "CREDENTIAL_SECRET")`; derivation literal untouched (whitelist). Add `credentialAlias.test.ts`: encrypt with legacy setup → decrypt under alias (fixture cipher text committed in test).
- [ ] **Step 4:** Update `.env.local` docs/examples (`docs/bots-voice-stt-voicestudio.md` gains a note: `ZCODE_BOT_STT_*` works during alias window, switch in P6).
- [ ] **Step 5:** Commit P2 (`rebrand(P2): MCODE_ env prefix with ZCODE_ dual-read`).

**Verify:** `pnpm typecheck && pnpm lint && pnpm test -- packages/services/src/test/credentialAlias.test.ts`; run dev app with ONLY legacy `ZCODE_*` env set → same behavior.

---

## Task 8 (P3): Data-directory migration `~/.zcode → ~/.mcode`

**Files:**
- Modify: `packages/services/src/paths.ts` (`getZCodeDataRootDir` + `copyDataDirectory` reuse), `apps/zcode-cli/packages/cli/src/env.ts`, `localUsageEvidence.ts`, `memoryService.ts`, `tui-runtime-loader.ts` (macOS cache)
- Create: `packages/services/src/test/pathsMigration.test.ts`

- [ ] **Step 1:** Root resolution: prefer `~/.mcode`; if absent and `~/.zcode` exists → recursive copy to `~/.mcode`, write marker `~/.mcode/MIGRATED_FROM_ZCODE` (schema 1, timestamp); copy failure → warn + continue on `~/.zcode` (fail-open). `~/.zcode-beta` and `~/Library/Caches/zcode` same pattern.
- [ ] **Step 2:** Workspace `.zcode/`: read prefers `.mcode`; lazy per-item copy (skills/workflows/config kinds `zcode.json`→`mcode.json` write-new-read-both); `workspace-hook-trust` records repoint to the new path on migration.
- [ ] **Step 3:** Migration tests: seeded fake HOME with `~/.zcode` (credentials.json with fixture `enc:v1:` blob, v2 config, cli/db, sessions, bot-state) → run resolution → assert tree copied, marker present, old dir untouched, second run is a no-op (idempotent).
- [ ] **Step 4:** Commit P3 (`rebrand(P3): data dir migration with fail-open`).

**Verify:** `pnpm --filter @zcode/services test src/test/pathsMigration.test.ts`; manual: dev profile with `ZCODE_DESKTOP_HOME_DIR` pointing at a seeded tree → bots/bot state load, credentials decrypt, sessions listed.

---

## Task 9 (P4): Package scope + directories `@mcode/*`

**Files:**
- Modify: `pnpm-workspace.yaml`, every `package.json` `name`, all `@zcode/...` import specifiers (~4,500 files), directory renames `apps/zcode-cli→apps/mcode-cli`, `packages/zcode-protocol*`→`packages/mcode-protocol*` (dir/package only - wire literal stays), `packages/zcode-cua*`, `packages/zcode-server-cli`
- Regenerate: `pnpm-lock.yaml`

- [ ] **Step 1:** Script P4 rules: `@zcode/`→`@mcode/` in source + configs; `git mv` the four directory families; update workspace globs, tsconfig references, scripts paths, wdio/e2e path constants, `.agents/skills` references.
- [ ] **Step 2:** `pnpm install` (lockfile regen, bin links). `node_modules/.bin/zcode` link disappears - expected until Task 10.
- [ ] **Step 3:** Fix every fallout until `pnpm typecheck && pnpm lint && pnpm architecture:check` pass; run root unit suite selection via `pnpm verify:pre-push`.
- [ ] **Step 4:** Commit P4 (`rebrand(P4): @mcode scope and directories`).

**Verify:** full typecheck/lint/arch green; `pnpm dev:desktop` boots; `pnpm dev:web` builds.

---

## Task 10 (P4): CLI bin `mcode` + `zcode` shim

**Files:**
- Modify: `apps/mcode-cli/packages/cli/package.json`, `src/process-name.ts`, SEA build scripts

- [ ] **Step 1:** `bin: { "mcode": "./dist/mcode.cjs", "zcode": "./dist/zcode-shim.cjs" }`; rename output artifact `mcode.cjs`; shim prints one deprecation line then `require("./mcode.cjs")`.
- [ ] **Step 2:** `CLI_COMMAND_NAME = "mcode"`; process-name/kill patterns in desktop `zcodeAgentProcessManager` use `mcode` with `zcode` legacy match during alias window; update `ZCODE_AGENT_SERVER_COMMAND` default resolution through Task 7's alias.
- [ ] **Step 3:** Commit P4b (`rebrand(P4): mcode bin with zcode shim`).

**Verify:** `pnpm --filter @mcode/cli build && ./node_modules/.bin/mcode --version` and `./node_modules/.bin/zcode --version` both work; desktop spawns agent via new command name.

---

## Task 11 (P5): IPC channels `mcode:*`

**Files:**
- Modify: `packages/shared/src/channels.ts` + every `invoke("zcode:...")`/listener site (script-driven, atomic)

- [ ] **Step 1:** Script P5 rule: `"zcode:` → `"mcode:` channel string literals, EXCEPT the three whitelisted DOM/DOM-event names (`zcode:error`, `zcode:set_globals`, `zcode:globals`) which are part of the public page API surface and stay until P6 decision.
- [ ] **Step 2:** Rename `zcode:get-zcode-stdio-tap-dev-state`-style compound names consistently (`mcode:get-mcode-stdio-tap-dev-state`).
- [ ] **Step 3:** Commit P5a (`rebrand(P5): internal IPC channels`).

**Verify:** desktop boots, RPC smoke via existing e2e selection; grep `rg -n '"zcode:' packages` returns only whitelisted DOM events.

---

## Task 12 (P5): `window.mcode` bridge + frozen `window.zcode` alias

**Files:**
- Modify: `packages/desktop/src/preload/index.ts` (+ sandbox preloads), renderer type globals
- Modify: `UI_PLUGIN.md` (document `window.mcode`, mark `window.zcode` deprecated)

- [ ] **Step 1:** Preload exposes the bridge object as `window.mcode`; `window.zcode = Object.freeze(new Proxy(window.mcode, deprecationWarnOnce))`.
- [ ] **Step 2:** Internal renderer/plugin-sandbox consumers move to `window.mcode` (212 refs, script-driven); third-party-facing docs updated.
- [ ] **Step 3:** Plugin regression: run an existing plugin e2e fixture that uses `window.zcode` - must still load and function via alias with exactly one deprecation console.warn.
- [ ] **Step 4:** Commit P5b (`rebrand(P5): window.mcode bridge with zcode alias`).

**Verify:** plugin fixture e2e green; `pnpm typecheck && pnpm lint`.

---

## Task 13 (P6, separate later release): cleanup

- [ ] Remove `ZCODE_*` dual-reads (keep only `MCODE_*`), `zcode` bin shim, legacy `Program Files\ZCode` fallback, `ZCODE_USER_AGENT_LEGACY` switch.
- [ ] Migration marker adoption check script; docs sweep; `.env.local` templates final.
- [ ] Exit criterion: two consecutive releases with migration markers ≥ target adoption.

---

## Task 14: Codify upstream replay flow

- [ ] Document in `docs/superpowers/specs/2026-10-29-mcode-deep-rebrand-design.md` (Upstream sync section pointer) the exact sequence: `git fetch origin && git merge origin/main && node scripts/rebrand/apply-mcode.mjs --phase P0..P5 && pnpm install && pnpm typecheck && pnpm lint`.
- [ ] CI guard (optional): a lint-time check that whitelisted literals exist unchanged (fails if a rename accidentally touched a Preserve item).

**Verify:** dry-run the script twice on the rebased tree - second run zero diff.

---

## Rollback

Every phase is one revert (`git revert <phase-commit>`). Cross-phase interactions to watch: P4 revert after P5 requires reverting P5 first (dependency order P0→P5). Data migration (P3) rollback: delete `~/.mcode` - original `~/.zcode` is never modified.

## Verification (whole plan)

Per phase as listed; additionally before ANY phase merge: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests via `pnpm verify:pre-push`. Human acceptance per phase: P0 screenshots (desktop+web+TUI), P1 installed package on Linux, P3 seeded-profile login with OLD credentials, P5 plugin via alias + both deep links + full OAuth.
