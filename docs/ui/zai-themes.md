# Zai Themes

## 目标

新增 `zai-light` 与 `zai-dark` 两套品牌主题，并由它们接管用户可见的 Light Theme / Dark Theme。
默认 `light` / `dark` CSS 变量仍作为底层 fallback 保留，但主题菜单不再暴露原生 light / dark 入口。

## 实现

- `Theme` 枚举保留 `light` / `dark` 作为旧偏好兼容值，实际持久化与应用时会规范化到 `zai-light` / `zai-dark`。
- `resolveTheme()` 将 `zai-light` 归入 light 分支，将 `zai-dark` 归入 dark 分支，继续复用标题栏、代码预览和移动端远控的明暗模式边界。
- `system` 会按系统明暗偏好套用 `zai-light` 或 `zai-dark`，避免回落到默认 CSS 主题。
- `styles.css` 中的 `.theme-zai-light` / `.theme-zai-dark` 使用 Zai semantic token 映射到项目现有 `--color-*` 语义变量，组件层不直接依赖 primitive 色阶。
- 桌面、Web 首屏 bootstrap、进程监控页和手机远控主题菜单都使用 Zai 主题入口，避免首帧回退或入口不可选。

## Dark green variants

Three green dark themes layered on top of `zai-dark`: `zai-dark-green` (gray + green details only), `zai-dark-forest` (gray surfaces with a whisper of green), `zai-dark-pine` (darkest, clearest green cast). The design is a mix, not a green repaint: the zai-dark gray ladder (dark gray page background, lighter gray containers, white text) stays the backbone, and green is detail work - borders, hover/selected states, and accent blocks use one fluorescent green alpha ramp that gets stronger from green to pine.

- Each variant is a delta override of `.theme-zai-dark`: in `styles.css` the variant class only redefines borders, hover/selected states, accent, and - for forest/pine - a progressively greener surface ladder. `zai-dark-green` overrides no surface tokens at all, so its backgrounds are byte-identical to `zai-dark`. Foreground text, semantic feedback colors, and chart colors keep inheriting from the `.theme-zai-dark` base block, so the white primary text is unchanged.
- `applyTheme()` mounts the `theme-zai-dark` base class and the variant class together; `resolveTheme()` maps every variant into the dark branch, so the title bar, code preview, and mobile remote control keep using the light/dark boundary. First-paint bootstrap (Web `index.html`, Web/Desktop `main.tsx`, the resource manager entry) also resolves variants to dark and mounts the variant class.
- The sidebar account menu and Settings → Appearance expose all variants; the mobile remote-control theme menu still only exposes `system` / `zai-dark` / `zai-light`, but variants can be applied through QR inheritance or the persisted `zcode-theme` value (`WebRemoteControlThemeSeed` includes the variants).
- Embedded WebViews (Coding Plan, Rewards) only accept `zai-light` / `zai-dark` in their URL; variants map back to `zai-dark` and do not add new WebView theme parameters.
- The semantic surface contrast test (`semanticSurfaceContrast.test.ts`) resolves variants with the "variant block + zai-dark base block" cascade and keeps the 4.5:1 gate.

## Token 映射

- `bg/page` -> `--color-background`
- `bg/bg` -> `--color-card`、`--color-popover`、`--color-input`、`--color-input-focused`
- `bg/surface` -> `--color-panel`
- `bg/overlay` -> `--color-background-win-alt`，并以 60% 透明度派生 `--color-background-alt`
- `text/primary` -> `--color-foreground`
- `text/secondary` -> `--color-foreground-subtle`
- `text/tertiary` -> `--color-foreground-subtlest`
- `border/default` -> `--color-border`
- `interactive/bg/primary/default` -> `--color-brand`、`--color-primary`
- `border/strong` -> `--color-input-border-focused`
- `accent/blue/default` -> 蓝色强调类辅助变量

Zai dark 的应用根前景色按当前 shell 参考类使用 `#ffffff`，而不是继续使用导出 token 中接近白色的 `#f8f8f8`。
