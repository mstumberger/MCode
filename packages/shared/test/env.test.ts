import { afterEach, describe, expect, it, vi } from "vitest";

async function importFreshEnvModule() {
  vi.resetModules();
  return await import("../src/env.js");
}

describe("shared runtime env", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("构建期可选能力未注入时关闭", async () => {
    const env = await importFreshEnvModule();

    // 单测不注入 ARMS 与自动更新。
    expect(env.ZCODE_ARMS_RUM_ENDPOINT).toBe("");
    expect(env.ZCODE_AUTO_UPDATE_ENABLED).toBe(false);
  });

  it("未注入 ZCODE_ENV 时默认 test 并映射为 local", async () => {
    vi.stubGlobal("__ZCODE_ENV__", undefined);

    const env = await importFreshEnvModule();

    expect(env.ZCODE_ENV).toBe("test");
    expect(env.normalizeZCodeEnv("development")).toBe("test");
    expect(env.mapZCodeEnvToArmsRumEnv("production")).toBe("local");
  });

  it("未注入身份 define 时 flavor 跟随 ZCODE_ENV", async () => {
    vi.stubGlobal("__ZCODE_ENV__", "production");
    vi.stubGlobal("__ZCODE_PRODUCT_FLAVOR__", undefined);

    const env = await importFreshEnvModule();

    expect(env.ZCODE_PRODUCT_FLAVOR).toBe("production");
    expect(env.normalizeZCodeProductFlavor(undefined, "test")).toBe("preview");
    expect(env.normalizeZCodeProductFlavor("bogus", "production")).toBe("production");
  });

  it("显式注入 preview 身份时生产后端构建仍是 Preview", async () => {
    vi.stubGlobal("__ZCODE_ENV__", "production");
    vi.stubGlobal("__ZCODE_PRODUCT_FLAVOR__", "preview");

    const env = await importFreshEnvModule();

    expect(env.ZCODE_ENV).toBe("production");
    expect(env.ZCODE_PRODUCT_FLAVOR).toBe("preview");
  });

  it("mapZCodeEnvToArmsRumEnv 将非本地 production 映射为 prod", async () => {
    vi.stubGlobal("__ZCODE_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapZCodeEnvToArmsRumEnv("production")).toBe("prod");
  });

  it("mapZCodeEnvToArmsRumEnv 在本地开发态忽略 production 产品环境并映射为 local", async () => {
    vi.stubGlobal("__ZCODE_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapZCodeEnvToArmsRumEnv("development")).toBe("local");
  });
});

describe("运行期遥测总开关 ZCODE_TELEMETRY_ENABLED", () => {
  const originalValue = process.env.ZCODE_TELEMETRY_ENABLED;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.ZCODE_TELEMETRY_ENABLED;
    } else {
      process.env.ZCODE_TELEMETRY_ENABLED = originalValue;
    }
    vi.unstubAllGlobals();
  });

  it.each(["0", "false", "off", "disabled"])(
    "显式 %s 时清空构建期注入的上报地址",
    async (value) => {
      vi.stubGlobal("__ZCODE_ARMS_RUM_ENDPOINT__", "https://arms.example.com/rum");
      vi.stubGlobal("__ZCODE_TELEMETRY_REPORT_ENDPOINT__", "https://arms.example.com/event");
      process.env.ZCODE_TELEMETRY_ENABLED = value;

      const env = await importFreshEnvModule();

      expect(env.ZCODE_ARMS_RUM_ENDPOINT).toBe("");
      expect(env.ZCODE_TELEMETRY_REPORT_ENDPOINT).toBe("");
    },
  );

  it("未设置总开关时保留构建期注入的上报地址", async () => {
    vi.stubGlobal("__ZCODE_ARMS_RUM_ENDPOINT__", "https://arms.example.com/rum");
    vi.stubGlobal("__ZCODE_TELEMETRY_REPORT_ENDPOINT__", "https://arms.example.com/event");
    delete process.env.ZCODE_TELEMETRY_ENABLED;

    const env = await importFreshEnvModule();

    expect(env.ZCODE_ARMS_RUM_ENDPOINT).toBe("https://arms.example.com/rum");
    expect(env.ZCODE_TELEMETRY_REPORT_ENDPOINT).toBe("https://arms.example.com/event");
  });

  it("总开关为非关闭值时不收紧构建期结果", async () => {
    vi.stubGlobal("__ZCODE_ARMS_RUM_ENDPOINT__", "https://arms.example.com/rum");
    process.env.ZCODE_TELEMETRY_ENABLED = "true";

    const env = await importFreshEnvModule();

    expect(env.ZCODE_ARMS_RUM_ENDPOINT).toBe("https://arms.example.com/rum");
  });
});
