# Spec: TUI `/exit` 命令

## 产品规则

- TUI 内输入 `/exit`（别名 `/quit`）立即退出终端 UI，进程退出码 0。
- 对齐 codex（`/quit` + `/exit` 同义）与 opencode（`/exit` 主名，`/quit`、`/q` 别名）的惯例：本命令采用 `/exit` 主名 + `/quit` 别名，不做 `/q`（单字母易误触）。
- 会话进行中（busy turn）同样可用，语义等同连按两次 Ctrl+C：终止当前回合并退出。已有排队输入一并丢弃。
- 带参数的 `/exit`（如 `/exit now`）不退出，回 usage 提示。
- headless（`-p`）下无交互会话可退：命令在 headless 入口直接返回提示文案，不提交给模型。
- 该命令只属于 CLI TUI surface；Desktop / Web / 协议侧不暴露。

## 状态所有者与事件顺序

退出所有权链不新增所有者：renderer 仍是进程退出的唯一触发者（`onExit`），CLI prompt handler 的清理仍由 `runTui` 返回后的 `promptHandler.close()` 收口。命令中心只产生"退出意图"，不直接碰进程。

```
idle：用户输入 /exit
  → createCommandCenter 返回 { response: "", exit: true }
  → TuiApp applyResult：识别 exit → onExit(0)（在追加 transcript 之前，避免渲染一闪而过的消息）
  → renderer.destroy() → runTui resolve(0)
  → runTuiCommand finally：promptHandler.close() → closeApp() + telemetry/registry 清理
  → 进程退出（exitCode 0）

busy：用户输入 /exit
  → TUI submitDuringActiveTurn → options.sendInput
  → tui-prompt-handler.sendInput：parse 出 known "exit" → 转 submitPrompt 路径
  → 之后同 idle（applyResult preserveTurnState=true 不影响 exit 分支，exit 检查在其之前）

Ctrl+C 双击退出路径不变：键盘 handler 直接 onExit(0)，不经过命令中心。
```

幂等边界：`onExit` 幂等（renderer.destroy 只触发一次 DESTROY）；`promptHandler.close()` 由 `closeHandlerPromise` 去重。

## 接口

- `TuiSubmitPromptResult`（`@zcode/tui`）新增可选字段 `exit?: boolean`：命令中心产生的退出意图。
- `TuiOptions` 新增可选字段 `exitTui?: (code: number) => void`：由 `tui.tsx` 注入（与 `setTerminalBackgroundColor`、`subscribeThemeMode` 同一注入模式），submit 流程（`app-submit.ts` 的 idle 与 busy 两条路径）在应用结果前识别 `exit` 并调用之；`applyResult` 不感知退出。
- 帮助条目：`BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES`（`@zcode/shared`）新增 `exit` 条目，`aliases: ["quit"]`。保留名集合（`isReservedZCodeSlashCommandName`）与 TUI 补全建议自动随条目派生，不单独维护。
- headless 入口（`prompt-command.ts`）：known `exit` 返回固定提示，不进入模型路径。

## 验收场景

1. TUI 空闲态输入 `/exit` 或 `/quit`：进程退出，退出码 0，无残留消息渲染。
2. busy turn 输入 `/exit`：当前回合终止，进程退出，清理超时不被绕过。
3. `/exit now`：不退出，显示 usage。
4. headless `zcode -p "/exit"`：返回提示文案，模型不收到 `/exit` 字面文本。
5. `/help exit` 与 `--help`：显示 exit 条目；`zcode --help` 的 Slash Commands 列表包含 `/exit`。
6. Ctrl+C 双击行为与改动前一致。
