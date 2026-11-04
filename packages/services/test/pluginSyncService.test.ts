import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginSyncService } from "../src/plugin-sync/pluginSyncService.js";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "zcode-plugin-sync-home-"));
}

async function writeZcodeUserConfig(
  home: string,
  value: Record<string, unknown>,
): Promise<string> {
  const configPath = join(home, ".zcode", "cli", "config.json");
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  return configPath;
}

async function readZcodeUserConfig(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(home, ".zcode", "cli", "config.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeInlinePlugin(
  root: string,
  directoryName: string,
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const pluginRoot = join(root, directoryName);
  await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    `${JSON.stringify({
      name: directoryName,
      description: `${directoryName} description`,
      version: "1.0.0",
      ...manifest,
    }, null, 2)}\n`,
    "utf-8",
  );
  await mkdir(join(pluginRoot, "skills", "demo"), { recursive: true });
  await writeFile(join(pluginRoot, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
  return pluginRoot;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
}

describe("plugin sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("lists user inline plugins from zcode plugins.dirs as local candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const pluginRoot = await writeInlinePlugin(join(home, "external"), "remote-tools", {
      name: "remote-tools",
      mcpServers: { docs: { command: "node", args: ["server.js"] } },
      commands: ["commands"],
      hooks: [{ event: "PreToolUse", command: "echo hook" }],
    });
    await writeZcodeUserConfig(home, {
      plugins: {
        dirs: [pluginRoot],
        enabledPlugins: {
          "remote-tools@inline": false,
        },
      },
    });
    const service = createPluginSyncService();

    // 修复依据：上游 v3.17.2 inline 插件同步改为统一数据同步形状 IDataSyncCategoryService，
    // listLocalUserPluginCandidates → listSyncItems；条目按 name@inline（小写）对齐，
    // 不再暴露 directoryName/path/componentTypes。
    const result = await service.listSyncItems();
    const canonicalPluginRoot = await realpath(pluginRoot);

    expect(result.items).toMatchObject([
      {
        key: "remote-tools@inline",
        name: "remote-tools",
        pluginId: "remote-tools@inline",
        description: "remote-tools description",
        version: "1.0.0",
        enabled: false,
      },
    ]);
    expect(result.homeDir).toBe(home);
    expect(canonicalPluginRoot).toBeTruthy();
  });

  it("checks remote plugin and config directory write access before sync", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const service = createPluginSyncService();

    // 修复依据：上游 v3.17.2 预检改名 checkSyncWriteAccess，目录列表语义不变。
    const result = await service.checkSyncWriteAccess();

    expect(result).toMatchObject({
      ok: true,
      path: [
        join(remoteHome, ".zcode", "plugins"),
        join(remoteHome, ".zcode", "cli"),
      ].join(", "),
    });
  });

  it("reports remote plugin write preflight failure when plugin root is not a directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".zcode"), { recursive: true });
    await writeFile(join(remoteHome, ".zcode", "plugins"), "not a directory");
    const service = createPluginSyncService();

    const result = await service.checkSyncWriteAccess();

    expect(result.ok).toBe(false);
    expect(result.path).toBe(join(remoteHome, ".zcode", "plugins"));
    expect(result.error).toBeTruthy();
  });

  it("does not list marketplace installed plugin cache records as V1 candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const cachePluginRoot = await writeInlinePlugin(
      join(home, ".zcode", "cli", "plugins", "cache", "market", "cached", "1.0.0"),
      "cached",
      { name: "cached" },
    );
    await mkdir(join(home, ".zcode", "cli", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "cli", "plugins", "installed_plugins.json"),
      `${JSON.stringify({
        plugins: [
          {
            id: "cached@market",
            name: "cached",
            marketplace: "market",
            version: "1.0.0",
            installPath: cachePluginRoot,
          },
        ],
      })}\n`,
      "utf-8",
    );
    const service = createPluginSyncService();

    const result = await service.listSyncItems();

    expect(result.items).toEqual([]);
  });

  it("imports selected inline plugins into the remote user plugin root and registers plugins.dirs", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const pluginRoot = await writeInlinePlugin(join(localHome, "external"), "remote-tools", {
      name: "remote-tools",
    });
    await writeZcodeUserConfig(localHome, {
      plugins: {
        dirs: [pluginRoot],
        enabledPlugins: {
          "remote-tools@inline": false,
        },
      },
    });
    const localService = createPluginSyncService();
    // 修复依据：上游 v3.17.2 导入导出改为 exportSyncItems / importSyncItems；
    // 新建结果状态为 created（原 synced），登记 plugins.dirs 与启用状态的行为不变。
    const exported = await localService.exportSyncItems({ keys: ["remote-tools@inline"] });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createPluginSyncService();
    const result = await remoteService.importSyncItems({
      payload: exported,
      items: [{ key: "remote-tools@inline", mode: "createOnly" }],
    });

    expect(result.results).toMatchObject([
      {
        key: "remote-tools@inline",
        status: "created",
      },
    ]);
    const remotePluginRoot = join(remoteHome, ".zcode", "plugins", "remote-tools");
    expect(existsSync(join(remotePluginRoot, ".zcode-plugin", "plugin.json"))).toBe(true);
    const remoteConfig = await readZcodeUserConfig(remoteHome);
    expect(remoteConfig).toMatchObject({
      plugins: {
        dirs: [resolve(remotePluginRoot)],
        enabledPlugins: {
          "remote-tools@inline": false,
        },
      },
    });
  });

  it("preserves executable file permissions when importing inline plugins", async () => {
    if (process.platform === "win32") {
      return;
    }
    const localHome = makeHome();
    process.env.HOME = localHome;
    const pluginRoot = await writeInlinePlugin(join(localHome, "external"), "remote-tools", {
      name: "remote-tools",
      commands: ["commands"],
    });
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    const localCommandPath = join(pluginRoot, "commands", "run.sh");
    await writeFile(localCommandPath, "#!/bin/sh\necho ok\n", "utf-8");
    await chmod(localCommandPath, 0o755);
    await writeZcodeUserConfig(localHome, { plugins: { dirs: [pluginRoot] } });
    const localService = createPluginSyncService();
    const exported = await localService.exportSyncItems({ keys: ["remote-tools@inline"] });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createPluginSyncService();
    await remoteService.importSyncItems({
      payload: exported,
      items: [{ key: "remote-tools@inline", mode: "createOnly" }],
    });

    const remoteCommandPath = join(
      remoteHome,
      ".zcode",
      "plugins",
      "remote-tools",
      "commands",
      "run.sh",
    );
    expect((await stat(remoteCommandPath)).mode & 0o777).toBe(0o755);
  });

  it("rolls back an inline plugin directory when config registration fails", async () => {
    if (process.platform === "win32") {
      return;
    }
    const localHome = makeHome();
    process.env.HOME = localHome;
    const pluginRoot = await writeInlinePlugin(join(localHome, "external"), "remote-tools", {
      name: "remote-tools",
    });
    await writeZcodeUserConfig(localHome, { plugins: { dirs: [pluginRoot] } });
    const localService = createPluginSyncService();
    const exported = await localService.exportSyncItems({ keys: ["remote-tools@inline"] });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeZcodeUserConfig(remoteHome, {});
    const remoteConfigDir = join(remoteHome, ".zcode", "cli");
    const remotePluginRoot = join(remoteHome, ".zcode", "plugins", "remote-tools");
    const remoteService = createPluginSyncService();

    await chmod(remoteConfigDir, 0o555);
    // 修复依据：上游 v3.17.2 config 登记失败时由 registerCreatedPlugins 回滚新建目录，
    // 该项状态为 failed（原 synced/failed 语义保留在 status 字段上）。
    const failed = await remoteService.importSyncItems({
      payload: exported,
      items: [{ key: "remote-tools@inline", mode: "createOnly" }],
    });
    await chmod(remoteConfigDir, 0o755);

    expect(failed.results).toMatchObject([
      {
        key: "remote-tools@inline",
        status: "failed",
      },
    ]);
    expect(existsSync(remotePluginRoot)).toBe(false);

    const retried = await remoteService.importSyncItems({
      payload: exported,
      items: [{ key: "remote-tools@inline", mode: "createOnly" }],
    });

    expect(retried.results).toMatchObject([
      {
        key: "remote-tools@inline",
        status: "created",
      },
    ]);
    expect(existsSync(remotePluginRoot)).toBe(true);
    const remoteConfig = await readZcodeUserConfig(remoteHome);
    expect(remoteConfig).toMatchObject({
      plugins: {
        dirs: [resolve(remotePluginRoot)],
      },
    });
  });

  it("reports conflict when the same plugin id already exists in remote plugins.dirs", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const pluginRoot = await writeInlinePlugin(join(localHome, "external"), "remote-tools", {
      name: "remote-tools",
    });
    await writeZcodeUserConfig(localHome, { plugins: { dirs: [pluginRoot] } });
    const localService = createPluginSyncService();
    const exported = await localService.exportSyncItems({ keys: ["remote-tools@inline"] });

    const remoteHome = makeHome();
    const existingRemoteRoot = await writeInlinePlugin(
      join(remoteHome, "existing"),
      "different-dir",
      { name: "remote-tools" },
    );
    await writeZcodeUserConfig(remoteHome, { plugins: { dirs: [existingRemoteRoot] } });
    process.env.HOME = remoteHome;
    const remoteService = createPluginSyncService();

    // 修复依据：上游 v3.17.2 createOnly 遇到目标端同 id 插件返回 conflict（原 skipped），
    // 不改写远端 plugins.dirs。
    const result = await remoteService.importSyncItems({
      payload: exported,
      items: [{ key: "remote-tools@inline", mode: "createOnly" }],
    });

    expect(result.results).toMatchObject([
      {
        key: "remote-tools@inline",
        status: "conflict",
      },
    ]);
    const remoteConfig = await readZcodeUserConfig(remoteHome);
    expect(remoteConfig).toMatchObject({ plugins: { dirs: [existingRemoteRoot] } });
  });

  it("reports remote existence by plugin id", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const existingRemoteRoot = await writeInlinePlugin(join(remoteHome, "existing"), "known", {
      name: "known",
    });
    await writeInlinePlugin(join(remoteHome, ".zcode", "plugins"), "known", {
      name: "other-known",
    });
    await writeZcodeUserConfig(remoteHome, { plugins: { dirs: [existingRemoteRoot] } });
    const service = createPluginSyncService();

    // 修复依据：上游 v3.17.2 删除了按目标目录查询状态的 RPC；远端存在性由
    // getSyncContentHashes 按 name@inline key 表达（未登记 plugins.dirs 的目录不算同步条目）。
    const result = await service.getSyncContentHashes({
      keys: ["known@inline", "new@inline"],
    });

    expect(Object.keys(result.hashes)).toEqual(["known@inline"]);
    expect(result.hashes["known@inline"]).toBeTruthy();
  });

  it("rejects plugin archives containing symlinks", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = makeHome();
    process.env.HOME = home;
    const pluginRoot = await writeInlinePlugin(join(home, "external"), "remote-tools", {
      name: "remote-tools",
    });
    await writeFile(join(home, "secret.txt"), "secret");
    symlinkSync(join(home, "secret.txt"), join(pluginRoot, "secret-link.txt"));
    await writeZcodeUserConfig(home, { plugins: { dirs: [pluginRoot] } });
    const service = createPluginSyncService();

    // 修复依据：上游 v3.17.2 软链拒绝移到 exportSyncItems 扫描（contains-symlink）。
    await expect(service.exportSyncItems({ keys: ["remote-tools@inline"] })).rejects.toThrow(
      "plugin contains a symbolic link",
    );
  });

  it("exports and imports a mirrored directory marketplace source", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const marketplaceRoot = join(localHome, "team-market");
    await writeInlinePlugin(marketplaceRoot, "formatter", { name: "formatter" });
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      `${JSON.stringify({
        name: "team-market",
        plugins: [
          {
            name: "formatter",
            version: "1.0.0",
            source: "./formatter",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const localService = createPluginSyncService();

    const exported = await localService.exportMarketplaceSourceArchive({
      marketplaceId: "team-market",
      pluginNames: ["formatter"],
      source: { source: "directory", path: marketplaceRoot },
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createPluginSyncService();
    const imported = await remoteService.importMarketplaceSourceArchive({
      archive: exported.archive,
      overwrite: false,
    });

    expect(imported).toMatchObject({
      marketplaceId: "team-market",
      status: "synced",
    });
    expect(imported.path.startsWith(join(remoteHome, ".zcode", "plugins", "marketplace-sources"))).toBe(true);
    const mirroredManifest = await readJsonFile(join(imported.path, "marketplace.json"));
    expect(mirroredManifest).toMatchObject({
      name: "team-market",
      metadata: {
        pluginRoot: "plugins",
      },
      plugins: [
        {
          name: "formatter",
          source: "./formatter",
        },
      ],
    });
    expect(
      existsSync(join(imported.path, "plugins", "formatter", ".zcode-plugin", "plugin.json")),
    ).toBe(true);
  });

  it("rejects absolute marketplace plugin source paths outside the marketplace root", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const marketplaceRoot = join(localHome, "team-market");
    const externalPluginRoot = await writeInlinePlugin(join(localHome, "external"), "formatter", {
      name: "formatter",
    });
    await mkdir(marketplaceRoot, { recursive: true });
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      `${JSON.stringify({
        name: "team-market",
        plugins: [
          {
            name: "formatter",
            source: externalPluginRoot,
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      createPluginSyncService().exportMarketplaceSourceArchive({
        marketplaceId: "team-market",
        pluginNames: ["formatter"],
        source: { source: "directory", path: marketplaceRoot },
      }),
    ).rejects.toThrow("unsafe marketplace plugin source path");
  });

  it("rejects mirrored marketplace plugin source directories without a plugin manifest", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const marketplaceRoot = join(localHome, "team-market");
    await mkdir(join(marketplaceRoot, "formatter"), { recursive: true });
    await writeFile(join(marketplaceRoot, "formatter", "README.md"), "not a plugin\n", "utf-8");
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      `${JSON.stringify({
        name: "team-market",
        plugins: [
          {
            name: "formatter",
            source: "./formatter",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      createPluginSyncService().exportMarketplaceSourceArchive({
        marketplaceId: "team-market",
        pluginNames: ["formatter"],
        source: { source: "directory", path: marketplaceRoot },
      }),
    ).rejects.toThrow("local marketplace plugin source is missing plugin manifest");
  });

  it("changes mirrored marketplace source directory when local plugin contents change", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const marketplaceRoot = join(localHome, "team-market");
    const pluginRoot = await writeInlinePlugin(marketplaceRoot, "formatter", {
      name: "formatter",
    });
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      `${JSON.stringify({
        name: "team-market",
        plugins: [{ name: "formatter", source: "./formatter" }],
      }, null, 2)}\n`,
      "utf-8",
    );
    const service = createPluginSyncService();

    const before = await service.exportMarketplaceSourceArchive({
      marketplaceId: "team-market",
      pluginNames: ["formatter"],
      source: { source: "directory", path: marketplaceRoot },
    });
    await writeFile(join(pluginRoot, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nnew");
    const after = await service.exportMarketplaceSourceArchive({
      marketplaceId: "team-market",
      pluginNames: ["formatter"],
      source: { source: "directory", path: marketplaceRoot },
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createPluginSyncService();
    const beforeImport = await remoteService.importMarketplaceSourceArchive({
      archive: before.archive,
      overwrite: false,
    });
    const afterImport = await remoteService.importMarketplaceSourceArchive({
      archive: after.archive,
      overwrite: false,
    });

    expect(afterImport.path).not.toBe(beforeImport.path);
  });

  it("mirrors same-marketplace dependencies with the selected marketplace plugin", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const marketplaceRoot = join(localHome, "team-market");
    await writeInlinePlugin(marketplaceRoot, "formatter", { name: "formatter" });
    await writeInlinePlugin(marketplaceRoot, "helper", { name: "helper" });
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      `${JSON.stringify({
        name: "team-market",
        plugins: [
          { name: "formatter", dependencies: ["helper"], source: "./formatter" },
          { name: "helper", source: "./helper" },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const exported = await createPluginSyncService().exportMarketplaceSourceArchive({
      marketplaceId: "team-market",
      pluginNames: ["formatter"],
      source: { source: "directory", path: marketplaceRoot },
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const imported = await createPluginSyncService().importMarketplaceSourceArchive({
      archive: exported.archive,
      overwrite: false,
    });
    const mirroredManifest = await readJsonFile(join(imported.path, "marketplace.json"));

    expect(exported.pluginNames).toEqual(["formatter", "helper"]);
    expect(mirroredManifest.plugins).toMatchObject([
      { name: "formatter", dependencies: ["helper"], source: "./formatter" },
      { name: "helper", source: "./helper" },
    ]);
    expect(existsSync(join(imported.path, "plugins", "helper"))).toBe(true);
  });

  it("exports a file marketplace source with plugin paths relative to the marketplace file", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const marketplaceRoot = join(localHome, "team-market");
    await writeInlinePlugin(marketplaceRoot, "formatter", { name: "formatter" });
    const marketplaceFile = join(marketplaceRoot, "marketplace.json");
    await writeFile(
      marketplaceFile,
      `${JSON.stringify({
        name: "team-market",
        plugins: [{ name: "formatter", source: "./formatter" }],
      }, null, 2)}\n`,
      "utf-8",
    );

    const exported = await createPluginSyncService().exportMarketplaceSourceArchive({
      marketplaceId: "team-market",
      pluginNames: ["formatter"],
      source: { source: "file", path: marketplaceFile },
    });
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const imported = await createPluginSyncService().importMarketplaceSourceArchive({
      archive: exported.archive,
      overwrite: false,
    });

    expect(existsSync(join(imported.path, "plugins", "formatter"))).toBe(true);
  });

  it("exports a settings marketplace source without local cache fallback when entries are remote", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const service = createPluginSyncService();

    const exported = await service.exportMarketplaceSourceArchive({
      marketplaceId: "team-market",
      pluginNames: ["formatter"],
      source: {
        source: "settings",
        marketplace: {
          name: "team-market",
          plugins: [
            {
              name: "formatter",
              version: "1.0.0",
              source: { source: "github", repo: "example/formatter-plugin" },
            },
          ],
        },
      },
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const imported = await createPluginSyncService().importMarketplaceSourceArchive({
      archive: exported.archive,
      overwrite: false,
    });
    const mirroredManifest = await readJsonFile(join(imported.path, "marketplace.json"));

    expect(mirroredManifest).toMatchObject({
      name: "team-market",
      plugins: [
        {
          name: "formatter",
          source: { source: "github", repo: "example/formatter-plugin" },
        },
      ],
    });
    expect(existsSync(join(imported.path, "plugins"))).toBe(false);
  });

  it("rejects settings marketplace entries whose local source root cannot be reconstructed", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const service = createPluginSyncService();

    await expect(
      service.exportMarketplaceSourceArchive({
        marketplaceId: "team-market",
        pluginNames: ["formatter"],
        source: {
          source: "settings",
          marketplace: {
            name: "team-market",
            plugins: [
              {
                name: "formatter",
                source: "./formatter",
              },
            ],
          },
        },
      }),
    ).rejects.toThrow("cannot mirror local marketplace plugin source");
  });
});
