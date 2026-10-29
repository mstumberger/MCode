export const BOT_MENU_COMMAND_ORDER = [
  "help",
  "status",
  "new",
  "workspace",
  // /task 是项目内会话选择器；不进菜单时用户只能盲敲命令，与“从项目选择会话继续”的核心流程相悖。
  "task",
  "model",
  "mode",
  "permissions",
  "thoughtLevel",
  "reply",
  "progress",
  "bind",
] as const;
