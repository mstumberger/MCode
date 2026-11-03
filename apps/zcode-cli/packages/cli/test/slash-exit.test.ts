import assert from "node:assert/strict";
import test from "node:test";
import { isReservedZCodeSlashCommandName } from "@zcode/bootstrap";
import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "@zcode/shared";
import { createCommandCenter } from "../src/command-center/create.js";
import { parseSlashCommand } from "../src/command-center/slash-commands.js";
import type { CommandCenterDeps } from "../src/command-center/types.js";

// docs/cli/exit-command.md 的验收场景 1/3/5 的可运行断言：
// busy 路径（场景 2）与真实 renderer 销毁依赖 TUI 运行时，属于 E2E 范围，这里不覆盖。
const neverCalledDeps = {
  getApp: async () => {
    throw new Error("/exit must not create an app");
  },
  getMode: () => "build" as const,
  recordInputHistory: async () => undefined,
  resumeApp: async () => {
    throw new Error("/exit must not resume an app");
  },
} satisfies CommandCenterDeps;

test("/exit and /quit parse as the known exit command", () => {
  const parsed = parseSlashCommand("/exit");
  assert.deepEqual(parsed, {
    args: "",
    name: "exit",
    rawName: "exit",
    type: "known",
  });
  assert.equal(parsed?.type === "known" && parsed.name, "exit");
  const quit = parseSlashCommand("/quit");
  assert.equal(quit?.type === "known" && quit.name, "exit");
});

test("/exit returns an exit intent without touching the app", async () => {
  const submitPrompt = createCommandCenter(neverCalledDeps);
  const result = await submitPrompt(
    { text: "/exit" },
    { abortSignal: new AbortController().signal },
  );

  assert.equal(result.exit, true);
  assert.equal(result.response, "");
  assert.equal(result.mode, "build");
});

test("/quit returns the same exit intent", async () => {
  const submitPrompt = createCommandCenter(neverCalledDeps);
  const result = await submitPrompt(
    { text: "/quit" },
    { abortSignal: new AbortController().signal },
  );

  assert.equal(result.exit, true);
});

test("/exit with arguments shows usage instead of exiting", async () => {
  const submitPrompt = createCommandCenter(neverCalledDeps);
  const result = await submitPrompt(
    { text: "/exit now" },
    { abortSignal: new AbortController().signal },
  );

  assert.equal(result.exit, undefined);
  assert.equal(result.response, "Usage: /exit");
});

test("exit help entry is registered with the quit alias", () => {
  const entry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
    (candidate) => candidate.name === "exit",
  );
  assert.ok(entry, "exit help entry missing");
  assert.deepEqual(entry.aliases ? [...entry.aliases] : [], ["quit"]);
});

test("exit and quit are reserved slash command names", () => {
  assert.equal(isReservedZCodeSlashCommandName("exit"), true);
  assert.equal(isReservedZCodeSlashCommandName("quit"), true);
});
