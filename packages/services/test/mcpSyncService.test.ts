import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "zcode-mcp-sync-home-"));
}

async function writeZcodeUserMcp(
  home: string,
  servers: Record<string, Record<string, unknown>>,
) {
  const configPath = join(home, ".zcode", "cli", "config.json");
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ mcp: { servers } }, null, 2)}\n`,
  );
  return configPath;
}

async function writeAgentsUserMcp(
  home: string,
  servers: Record<string, Record<string, unknown>>,
) {
  const configPath = join(home, ".agents", "mcp.json");
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
  );
  return configPath;
}

async function readRemoteZcodeServers(home: string) {
  const raw = await readFile(join(home, ".zcode", "cli", "config.json"), "utf-8");
  const parsed = JSON.parse(raw) as {
    mcp?: { servers?: Record<string, Record<string, unknown>> };
  };
  return parsed.mcp?.servers ?? {};
}

describe("mcp sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("lists user zcode MCP servers as local candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeZcodeUserMcp(home, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起 listLocalUserMcpCandidates 收敛为通用数据同步合同
    // listSyncItems（key 为小写规范化名），不再返回 source/path/config。
    const result = await service.listSyncItems();

    expect(result.homeDir).toBe(home);
    expect(result.items).toMatchObject([
      {
        key: "context7",
        name: "context7",
        enabled: true,
      },
    ]);
    expect(result).not.toHaveProperty("importBlockedReason");
  });

  it("marks a candidate disabled when only enabled:false is present", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 外部工具/手工编辑写的是 enabled:false；同步侧不能把它当成启用状态。
    await writeZcodeUserMcp(home, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enabled: false,
      },
    });
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起改用 listSyncItems 读取候选（key 为小写规范化名）。
    const result = await service.listSyncItems();

    expect(result.items[0]).toMatchObject({ key: "context7", enabled: false });
  });

  it("clears a stale enabled flag when toggling a server", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 线上配置里 enable 与 enabled 并存，切换开关后不能再留下自相矛盾的字段。
    await writeZcodeUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enabled: true,
      },
    });
    const service = createMcpSyncService();

    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "context7",
      enabled: false,
    });

    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });

    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "context7",
      enabled: true,
    });

    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
  });

  it("migrates a legacy enable flag to enabled when listing candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 存量配置只有桌面端历史写入的 enable；同步侧读取时应就地迁移成契约字段 enabled。
    await writeZcodeUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enable: false,
      },
    });
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起改用 listSyncItems 读取候选（key 为小写规范化名）。
    const result = await service.listSyncItems();

    expect(result.items[0]).toMatchObject({ key: "context7", enabled: false });
    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });
  });

  it("keeps a candidate disabled when legacy enable:false collides with enabled:true", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 线上事故配置：停用写了 enable:false，但外部导入残留 enabled:true。迁移必须保住停用语义。
    await writeZcodeUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enable: false,
        enabled: true,
      },
    });
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起改用 listSyncItems 读取候选（key 为小写规范化名）。
    const result = await service.listSyncItems();

    expect(result.items[0]).toMatchObject({ key: "context7", enabled: false });
    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });
  });

  it("leaves the config file untouched when no legacy enable flag exists", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 迁移必须幂等：没有残留字段时不能重写文件，否则每次列举候选都会动用户的配置。
    // 故意用非规范化的紧凑 JSON 落盘，任何重写都会改变字节内容。
    const configPath = join(home, ".zcode", "cli", "config.json");
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    const raw = JSON.stringify({
      mcp: {
        servers: {
          context7: {
            command: "npx",
            args: ["-y", "@upstash/context7-mcp"],
            enabled: false,
          },
        },
      },
    });
    await writeFile(configPath, raw);
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起改用 listSyncItems 读取候选。
    await service.listSyncItems();

    await expect(readFile(configPath, "utf-8")).resolves.toBe(raw);
  });

  it("checks remote MCP config directory write access before sync", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起 checkRemoteUserMcpWriteAccess 收敛为通用数据同步
    // 合同 checkSyncWriteAccess，结果仍是 { ok, path, error? }。
    const result = await service.checkSyncWriteAccess();

    expect(result).toMatchObject({
      ok: true,
      path: join(remoteHome, ".zcode", "cli"),
    });
  });

  it("reports remote MCP write preflight failure when cli path is not a directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".zcode"), { recursive: true });
    await writeFile(join(remoteHome, ".zcode", "cli"), "not a directory");
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起改用 checkSyncWriteAccess。
    const result = await service.checkSyncWriteAccess();

    expect(result.ok).toBe(false);
    expect(result.path).toBe(join(remoteHome, ".zcode", "cli"));
    expect(result.error).toBeTruthy();
  });

  it("falls back to user agents MCP servers when zcode user MCP is empty", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeAgentsUserMcp(home, {
      docs: {
        type: "http",
        url: "https://mcp.example.com/mcp",
      },
    });
    const service = createMcpSyncService();

    // 修复依据：上游 v3.17.2 起 listSyncItems 覆盖 ~/.agents 兼容回退，
    // 并以 importBlockedReason=target-compat-config 标记该兼容态。
    const result = await service.listSyncItems();

    expect(result.items).toMatchObject([
      {
        key: "docs",
        name: "docs",
        enabled: true,
      },
    ]);
    expect(result).toMatchObject({ importBlockedReason: "target-compat-config" });
  });

  it("imports stdio and HTTP MCP servers while preserving secrets", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { CONTEXT7_API_KEY: "secret-local" },
      },
      docsApi: {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer secret-token" },
      },
    });
    const localService = createMcpSyncService();
    // 修复依据：上游 v3.17.2 起 export/import 改为 exportSyncItems/importSyncItems
    // 数据同步合同：列表取 key，导入按 key + mode=createOnly 幂等创建。
    const listed = await localService.listSyncItems();
    const exported = await localService.exportSyncItems({
      keys: listed.items.map((item) => item.key),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createMcpSyncService();
    const result = await remoteService.importSyncItems({
      items: listed.items.map((item) => ({ key: item.key, mode: "createOnly" as const })),
      payload: exported,
    });

    expect(result.results).toMatchObject([
      { key: "context7", status: "created" },
      { key: "docsapi", status: "created" },
    ]);
    const remoteServers = await readRemoteZcodeServers(remoteHome);
    expect(remoteServers.context7).toMatchObject({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "secret-local" },
    });
    expect(remoteServers.docsApi).toMatchObject({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  it("creates imported remote MCP config with owner-only permissions", async () => {
    if (process.platform === "win32") {
      return;
    }

    const previousUmask = process.umask(0o000);
    try {
      const remoteHome = makeHome();
      process.env.HOME = remoteHome;
      const remoteService = createMcpSyncService();

      // 修复依据：上游 v3.17.2 起导入走 importSyncItems + McpDataSyncPayload
      // （items 为 { key, name, config, enabled }，key 为小写规范化名）。
      await remoteService.importSyncItems({
        items: [{ key: "docsapi", mode: "createOnly" }],
        payload: {
          sourceHomeDir: "/Users/local",
          items: [
            {
              key: "docsapi",
              name: "docsApi",
              enabled: true,
              config: {
                type: "http",
                url: "https://mcp.example.com/mcp",
                headers: { Authorization: "Bearer secret-token" },
              },
            },
          ],
        },
      });

      const configMode = (await stat(join(remoteHome, ".zcode", "cli", "config.json")))
        .mode;
      expect(configMode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("fails remote import without overwriting an invalid zcode config file", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const localService = createMcpSyncService();
    // 修复依据：上游 v3.17.2 起 export/import 改为数据同步合同。
    const listed = await localService.listSyncItems();
    const exported = await localService.exportSyncItems({
      keys: listed.items.map((item) => item.key),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const invalidConfigPath = join(remoteHome, ".zcode", "cli", "config.json");
    await mkdir(join(remoteHome, ".zcode", "cli"), { recursive: true });
    await writeFile(invalidConfigPath, '{"mcp":');
    const remoteService = createMcpSyncService();

    const result = await remoteService.importSyncItems({
      items: listed.items.map((item) => ({ key: item.key, mode: "createOnly" as const })),
      payload: exported,
    });
    expect(result.results.every((item) => item.status === "failed")).toBe(true);
    expect(result.results[0]?.error).toMatch(/config\.json/);
    await expect(readFile(invalidConfigPath, "utf-8")).resolves.toBe('{"mcp":');
  });

  it("loads and saves user MCP through the service on the current host", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const service = createMcpSyncService();

    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "deepwiki",
      config: {
        type: "http",
        url: "https://mcp.deepwiki.com/mcp",
      },
    });

    const result = await service.loadMcpFromUserDirectory();

    expect(result.servers).toMatchObject([
      {
        source: "zcodeagentmcp",
        scope: "user",
        name: "deepwiki",
        config: {
          type: "http",
          url: "https://mcp.deepwiki.com/mcp",
        },
      },
    ]);
    expect(result.servers[0]?.file?.filePath).toBe(
      join(home, ".zcode", "cli", "config.json"),
    );
  });

  it("loads workspace MCP before user MCP using the same directory precedence", async () => {
    const home = makeHome();
    const workspace = join(home, "workspace");
    process.env.HOME = home;
    await writeZcodeUserMcp(home, {
      userOnly: { type: "http", url: "https://user.example.test/mcp" },
    });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify(
        {
          mcp: {
            servers: {
              workspaceOnly: {
                type: "http",
                url: "https://workspace.example.test/mcp",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const service = createMcpSyncService();

    const result = await service.loadMcpFromUserDirectory({ workspacePath: workspace });

    expect(result.servers.map((server) => `${server.scope}:${server.name}`)).toEqual([
      "workspace:workspaceOnly",
      "user:userOnly",
    ]);
  });

  it("rewrites filesystem MCP home and workspace paths for the remote host", async () => {
    const localHome = makeHome();
    const localWorkspacePath = join(localHome, "workspace", "z-code");
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      filesystem: {
        type: "stdio",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          join(localWorkspacePath, "src"),
          join(localHome, "Documents"),
        ],
      },
    });
    const localService = createMcpSyncService();
    // 修复依据：上游 v3.17.2 起 export/import 改为数据同步合同；workspace 路径改写
    // 通过 exportSyncItems 的 workspace 参数声明 source/target。
    const listed = await localService.listSyncItems();
    const exported = await localService.exportSyncItems({
      keys: listed.items.map((item) => item.key),
      workspace: {
        sourceWorkspacePath: localWorkspacePath,
        targetWorkspacePath: "/srv/z-code",
      },
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createMcpSyncService();
    await remoteService.importSyncItems({
      items: listed.items.map((item) => ({ key: item.key, mode: "createOnly" as const })),
      payload: exported,
    });

    const remoteServers = await readRemoteZcodeServers(remoteHome);
    expect(remoteServers.filesystem?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/srv/z-code/src",
      join(remoteHome, "Documents"),
    ]);
  });

  it("skips same-name remote MCP servers without overwriting", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const localService = createMcpSyncService();
    // 修复依据：上游 v3.17.2 起 export/import 改为数据同步合同；同名冲突在
    // createOnly 模式下返回 conflict，不写入任何内容。
    const listed = await localService.listSyncItems();
    const exported = await localService.exportSyncItems({
      keys: listed.items.map((item) => item.key),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeZcodeUserMcp(remoteHome, {
      context7: {
        type: "stdio",
        command: "existing-command",
      },
    });
    const remoteService = createMcpSyncService();

    const result = await remoteService.importSyncItems({
      items: listed.items.map((item) => ({ key: item.key, mode: "createOnly" as const })),
      payload: exported,
    });

    expect(result.results).toEqual([
      {
        key: "context7",
        status: "conflict",
      },
    ]);
    const remoteServers = await readRemoteZcodeServers(remoteHome);
    expect(remoteServers.context7).toMatchObject({
      command: "existing-command",
    });
  });
});
