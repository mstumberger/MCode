import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SKILL_SCAN_DEPTH, SKILL_SYNC_SIZE_LIMIT_ERROR_CODE } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillSyncService } from "../src/skill-sync/skillSyncService.js";
import { createSkillSyncArchive } from "../src/skill-sync/skillSyncArchive.js";

// 修复依据：上游 v3.17.2 把技能同步改造成统一的数据同步形状 IDataSyncCategoryService
// （docs/remote/data-sync.md）：listLocalUserSkillCandidates → listSyncItems、
// checkRemoteUserSkillWriteAccess → checkSyncWriteAccess、listRemoteUserSkillStatuses →
// getSyncContentHashes、exportSkillsArchive → exportSyncItems、importSkillsArchive →
// importSyncItems。以下用例按新合同改写，断言语义保持不变。

async function symlinkSkillDirectory(target: string, linkPath: string) {
  // 修复原因：Windows 普通目录 symlink 依赖开发者模式或管理员权限，CI/本机 pre-push
  // 可能直接 EPERM；junction 能覆盖同样的 realpath 去重语义且不需要额外权限。
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), "zcode-skill-sync-home-"));
}

async function writeSkill(
  home: string,
  directoryName: string,
  name = directoryName,
  root: ".zcode" | ".agents" = ".zcode",
) {
  const dir = join(home, root, "skills", directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} desc\n---\nBody`,
  );
  return dir;
}

async function writeBareSkill(
  home: string,
  directoryName: string,
  root: ".zcode" | ".agents" = ".zcode",
) {
  const dir = join(home, root, "skills", directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "Body");
  return dir;
}

describe("skill sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("lists local user zcode skills as candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeSkill(home, "review");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listSyncItems();

    expect(result.homeDir).toBe(home);
    expect(result.items).toMatchObject([
      {
        key: "review",
        name: "review",
        description: "review desc",
        enabled: true,
      },
    ]);
  });

  it("checks remote skill root write access before sync", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.checkSyncWriteAccess();

    // 修复依据：上游 v3.17.2 写入预检改为 checkRemoteSyncDirectoriesWriteAccess，
    // 技能根与 ~/.zcode/cli（config.json 启用状态）都要可写；成功时 path 是目录列表。
    expect(result).toMatchObject({
      ok: true,
      path: [join(remoteHome, ".zcode", "skills"), join(remoteHome, ".zcode", "cli")].join(", "),
    });
  });

  it("reports remote skill write preflight failure when the target is not a directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".zcode"), { recursive: true });
    await writeFile(join(remoteHome, ".zcode", "skills"), "not a directory");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.checkSyncWriteAccess();

    expect(result.ok).toBe(false);
    expect(result.path).toBe(join(remoteHome, ".zcode", "skills"));
    expect(result.error).toBeTruthy();
  });

  it("lists local user agents skills as candidates when zcode skills are empty", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeSkill(home, "lark-doc", "lark-doc", ".agents");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listSyncItems();

    expect(result.items).toMatchObject([
      {
        key: "lark-doc",
        name: "lark-doc",
        description: "lark-doc desc",
        enabled: true,
      },
    ]);
  });

  it("does not list skills beyond the shared scan depth limit", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const deepPath = Array.from(
      { length: MAX_SKILL_SCAN_DEPTH + 2 },
      (_, index) => `level-${index}`,
    ).join("/");
    await writeSkill(home, `${deepPath}/too-deep`);
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listSyncItems();

    expect(result.items.map((item) => item.key)).not.toContain("too-deep");
  });

  it("deduplicates agents skills already covered by zcode skills", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeSkill(home, "review-zcode", "review", ".zcode");
    await writeSkill(home, "review-agents", "review", ".agents");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listSyncItems();

    // 修复依据：上游 v3.17.2 条目按归一化技能名对齐（key），同一名字只保留一项。
    expect(result.items.map((item) => item.key)).toEqual(["review"]);
    // 同名去重时 .zcode 优先：导出 payload 的 directoryName 必须来自 .zcode 目录。
    const exported = await service.exportSyncItems({ keys: ["review"] });
    expect(exported.items).toMatchObject([
      { key: "review", name: "review", directoryName: "review-zcode", enabled: true },
    ]);
  });

  it("deduplicates agents skills already covered by zcode symlink realpath", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const sourceDir = await writeBareSkill(home, "external-source", ".agents");
    const zcodeRoot = join(home, ".zcode", "skills");
    await mkdir(zcodeRoot, { recursive: true });
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "linked-external"));
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listSyncItems();

    expect(result.items.map((item) => item.key)).toEqual(["linked-external"]);
  });

  it("deduplicates agents skills covered by raw zcode directory names before realpath de-dupe", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const sourceDir = join(home, "external-source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "Body");
    const zcodeRoot = join(home, ".zcode", "skills");
    await mkdir(zcodeRoot, { recursive: true });
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "aaa-link"));
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "agents-only"));
    await writeBareSkill(home, "agents-only", ".agents");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listSyncItems();

    expect(result.items.map((item) => item.key)).toEqual(["aaa-link"]);
  });

  it("exports nested agents skills preserving their relative directory path", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "group/review", "review", ".agents");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const listed = await localService.listSyncItems();

    expect(listed.items.map((item) => item.key)).toEqual(["review"]);

    const payload = await localService.exportSyncItems({ keys: ["review"] });
    expect(payload.items).toMatchObject([{ key: "review", directoryName: "group/review" }]);
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSyncItems({
      payload,
      items: [{ key: "review", mode: "createOnly" }],
    });

    expect(result.results[0]).toMatchObject({
      key: "review",
      status: "created",
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "group", "review", "SKILL.md"), "utf-8"),
    ).resolves.toContain("name: review");
  });

  it("exports zcode skill directory symlinks as regular remote skill directories", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const sourceDir = await writeSkill(localHome, "external-source", "external", ".agents");
    const zcodeRoot = join(localHome, ".zcode", "skills");
    await mkdir(zcodeRoot, { recursive: true });
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "linked-external"));
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const listed = await localService.listSyncItems();

    expect(listed.items).toMatchObject([
      {
        key: "external",
        name: "external",
        description: "external desc",
      },
    ]);

    const payload = await localService.exportSyncItems({ keys: ["external"] });
    // 归档按候选目录名落位：zcode 里的软链目录以 linked-external 导出。
    expect(payload.items).toMatchObject([{ key: "external", directoryName: "linked-external" }]);
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSyncItems({
      payload,
      items: [{ key: "external", mode: "createOnly" }],
    });

    expect(result.results[0]).toMatchObject({
      key: "external",
      status: "created",
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "linked-external", "SKILL.md"), "utf-8"),
    ).resolves.toContain("name: external");
  });

  it("imports missing skills and reports conflict for existing names on re-import", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "review");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const payload = await localService.exportSyncItems({ keys: ["review"] });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "existing");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const first = await remoteService.importSyncItems({
      payload,
      items: [{ key: "review", mode: "createOnly" }],
    });
    // 修复依据：上游 v3.17.2 createOnly 模式下目标端已有同名技能不再写「skipped」，
    // 而是返回 conflict，由调用方刷新列表后重试。
    const second = await remoteService.importSyncItems({
      payload,
      items: [{ key: "review", mode: "createOnly" }],
    });

    expect(first.results[0]).toMatchObject({ key: "review", status: "created" });
    expect(second.results[0]).toMatchObject({ key: "review", status: "conflict" });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "review", "SKILL.md"), "utf-8"),
    ).resolves.toContain("name: review");
  });

  it("marks remote skills as existing when the skill name already exists in another directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "remote-review-copy", "review");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    // 修复依据：上游 v3.17.2 远端存在性改由 getSyncContentHashes 表达：
    // 目标端能按名字 key 找到该项并算出哈希即「已存在」。
    const status = await remoteService.getSyncContentHashes({ keys: ["review"] });

    expect(Object.keys(status.hashes)).toEqual(["review"]);
    expect(status.hashes.review).toBeTruthy();
  });

  it("marks remote agents skills as existing when the same skill name exists there", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "agents-review-copy", "review", ".agents");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const status = await remoteService.getSyncContentHashes({ keys: ["review"] });

    expect(Object.keys(status.hashes)).toEqual(["review"]);
    expect(status.hashes.review).toBeTruthy();
  });

  it("rejects sync payload directory names that escape the skill root", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".ssh"), { recursive: true });
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    // 修复依据：上游 v3.17.2 删除了按 directoryNames 查询远端状态的 RPC；
    // 路径逃逸防护（resolveSkillSyncPathWithin）移到导入 payload 的 directoryName 校验。
    const payload = {
      archive: await createSkillSyncArchive([]),
      sourceHomeDir: remoteHome,
      items: [
        {
          key: "escape",
          name: "escape",
          directoryName: "../../.ssh",
          enabled: true,
        },
      ],
    };

    await expect(
      remoteService.importSyncItems({
        payload,
        items: [{ key: "escape", mode: "createOnly" }],
      }),
    ).rejects.toThrow("unsafe skill sync path");
  });

  it("rejects sync payload skill metadata directory names that escape the skill root", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    // 修复依据：同上，逃逸校验统一落在导入路径解析（skillSyncPath）上。
    const payload = {
      archive: await createSkillSyncArchive([]),
      sourceHomeDir: remoteHome,
      items: [
        {
          key: "escape",
          name: "escape",
          directoryName: "../review",
          enabled: true,
        },
      ],
    };

    await expect(
      remoteService.importSyncItems({
        payload,
        items: [{ key: "escape", mode: "createOnly" }],
      }),
    ).rejects.toThrow("unsafe skill sync path");
  });

  it("reports conflict when the remote already has the same skill name in another directory", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "local-review", "review");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const payload = await localService.exportSyncItems({ keys: ["review"] });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "remote-review-copy", "review");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSyncItems({
      payload,
      items: [{ key: "review", mode: "createOnly" }],
    });

    // 修复依据：上游 v3.17.2 目标端已有同名技能时返回 conflict（不再写 skipped/path）。
    expect(result.results[0]).toMatchObject({
      key: "review",
      status: "conflict",
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "local-review", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("reports conflict when the remote agents root already has the same skill name", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "local-review", "review");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const payload = await localService.exportSyncItems({ keys: ["review"] });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "agents-review-copy", "review", ".agents");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSyncItems({
      payload,
      items: [{ key: "review", mode: "createOnly" }],
    });

    expect(result.results[0]).toMatchObject({
      key: "review",
      status: "conflict",
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "local-review", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("rejects export when selected skill content exceeds the sync size limit before gzip", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const skillDir = await writeSkill(home, "large-skill");
    await writeFile(join(skillDir, "large.txt"), "a".repeat(4096));
    const service = createSkillSyncService({ maxArchiveBytes: 1024 });

    await expect(service.exportSyncItems({ keys: ["large-skill"] })).rejects.toMatchObject({
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: expect.any(Number),
        maxBytes: 1024,
        phase: "selected-content",
      },
    });
  });

  it("rejects import when extracted skill content exceeds the sync size limit", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const skillDir = await writeSkill(localHome, "large-skill");
    await writeFile(join(skillDir, "large.txt"), "a".repeat(4096));
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const payload = await localService.exportSyncItems({ keys: ["large-skill"] });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 });

    await expect(
      remoteService.importSyncItems({
        payload,
        items: [{ key: "large-skill", mode: "createOnly" }],
      }),
    ).rejects.toMatchObject({
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: expect.any(Number),
        maxBytes: 1024,
        phase: "extracted-content",
      },
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "large-skill", "large.txt"), "utf-8"),
    ).rejects.toThrow();
  });
});
