#!/usr/bin/env node
/**
 * Deterministic, replayable ZCode -> MCode rename layer.
 * Spec: docs/superpowers/specs/2026-10-29-mcode-deep-rebrand-design.md
 * Plan: docs/superpowers/plans/2026-10-29-mcode-deep-rebrand.md
 *
 * Usage:
 *   node scripts/rebrand/apply-mcode.mjs --dry-run              # plan all phases
 *   node scripts/rebrand/apply-mcode.mjs --phase P0             # apply phase rules
 *   node scripts/rebrand/apply-mcode.mjs --phase P0 --verbose   # per-rule counts
 *
 * Guarantees:
 *   - Idempotent: a second run produces zero diff (rules match only the old name).
 *   - Preserve list (scripts/rebrand/whitelist.mjs) is never rewritten: any
 *     replacement span intersecting a protected literal throws before writing.
 *   - Only git-tracked files are touched (walks `git ls-files`).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCLUDED_PATHS, PRESERVE_LITERALS, PRESERVE_POSTCONDITIONS } from "./whitelist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @returns {[number, number][]} protected [start,end) ranges in `content`. */
function protectedRanges(content) {
  const ranges = [];
  for (const literal of PRESERVE_LITERALS) {
    for (let i = content.indexOf(literal); i !== -1; i = content.indexOf(literal, i + 1)) {
      ranges.push([i, i + literal.length]);
    }
  }
  return ranges;
}

function overlaps(range, protectedRanges) {
  return protectedRanges.some(([s, e]) => range[0] < e && s < range[1]);
}

/**
 * A rule rewrites `match` (string or RegExp, non-global) to `replace` inside
 * files whose repo-relative path satisfies `include` (RegExp). For
 * identifier-heavy files use `replaceFn(matchedText) => newText` together with
 * a `match` RegExp that spans exactly the quoted string, so property keys and
 * TS symbols are never touched. Rules are grouped by phase; a rule may carry
 * `note` for the --verbose report.
 * @typedef {{ id: string, phase: string, match: string | RegExp, replace?: string, replaceFn?: (matched: string) => string, include: RegExp, note?: string }} Rule
 */

/** Quotes-only transform: rewrite ZCode -> MCode inside the matched span. */
const mcodeInSpan = (span) => span.replaceAll("ZCode", "MCode");

/** Matches a complete double-quoted string containing ZCode (no newlines). */
const QUOTED_ZCODE = /"[^"\n]*ZCode[^"\n]*"/;

/** Matches a complete backtick template/comment span containing ZCode (no newlines). */
const BACKTICK_ZCODE = /`[^`\n]*ZCode[^`\n]*`/;

/** Product identity module + its contract test (same field/value literals). */
const PRODUCT_IDENTITY_FILES =
  /packages\/desktop\/(scripts\/desktop-product-identity\.mjs|test\/desktopProductIdentity\.test\.ts)$/;

/** @type {Rule[]} */
const RULES = [
  // ---- P0: display strings -------------------------------------------------
  {
    id: "p0-desktop-runtime-name",
    phase: "P0",
    match: '"ZCode Dev"',
    replace: '"MCode Dev"',
    include: /packages\/desktop\/src\/main\/desktopRuntimeEnv\.ts$/,
    note: "runtime app name (dev)",
  },
  {
    id: "p0-desktop-runtime-preview",
    phase: "P0",
    match: '"ZCode Preview"',
    replace: '"MCode Preview"',
    include: /packages\/desktop\/src\/main\/desktopRuntimeEnv\.ts$/,
    note: "runtime app name (preview)",
  },
  {
    id: "p0-desktop-runtime-default",
    phase: "P0",
    match: ': "ZCode"',
    replace: ': "MCode"',
    include: /packages\/desktop\/src\/main\/desktopRuntimeEnv\.ts$/,
    note: "packaged default app name",
  },
  {
    id: "p0-desktop-about",
    phase: "P0",
    match: "ZCode Desktop App",
    replace: "MCode Desktop App",
    include: /packages\/desktop\/src\/main\/|packages\/shared\/src\/desktopMenu\.ts$/,
  },
  {
    // Fixup after the P0 commit: the ownership-marker rename above was applied to
    // src/main but not to the test seeds, leaving 3 registration tests red. At the
    // (P1) mcode.desktop path only MCode builds ever write entries, so the seeds
    // must carry the MCode marker exactly like the app writes it.
    id: "p0-desktop-about-test-seeds",
    phase: "P0",
    match: "Comment=ZCode Desktop App",
    replace: "Comment=MCode Desktop App",
    include: /packages\/desktop\/test\/desktopLinuxDeepLinkRegistration\.test\.ts$/,
  },
  {
    id: "p0-desktop-menu-strings",
    phase: "P0",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/shared\/src\/desktopMenu\.ts$/,
    note: "tray/menu/about zh+en values (quoted strings only)",
  },
  {
    id: "p0-desktop-dialogs",
    phase: "P0",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/desktop\/src\/main\/(forceUpdateGuard|forceUpdatePrompt|desktopOAuthDeepLink)\.ts$/,
  },
  {
    // Fixup after the P0 commit: the p0-desktop-dialogs rule renamed the
    // workspace-open dialog copy in src/main but not this test's expectations.
    id: "p0-desktop-dialogs-test-copy",
    phase: "P0",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/desktop\/test\/desktopOAuthDeepLink\.test\.ts$/,
  },
  {
    // Task 2 Step 2 (applied late): Windows Explorer folder context menu. The
    // registry key switches to MCode.OpenInMCode; the legacy ZCode.OpenInZCode
    // key written by old installs is intentionally NOT rewritten or cleaned up
    // (spec risk register: stale remnants on upgraded machines are harmless),
    // so side-by-side installs keep one menu entry per app.
    id: "p0-windows-context-menu-key",
    phase: "P0",
    match: "ZCode.OpenInZCode",
    replace: "MCode.OpenInMCode",
    include:
      /packages\/desktop\/(src\/main\/desktopWindowsOpenFolderContextMenu\.ts|test\/desktopDeepLinkUrl\.test\.ts)$/,
  },
  {
    id: "p0-windows-context-menu-label-zh",
    phase: "P0",
    match: "在ZCode中打开",
    replace: "在MCode中打开",
    include:
      /packages\/desktop\/(src\/main\/desktopWindowsOpenFolderContextMenu\.ts|test\/desktopDeepLinkUrl\.test\.ts)$/,
  },
  {
    id: "p0-windows-context-menu-label-en",
    phase: "P0",
    match: "Open in ZCode",
    replace: "Open in MCode",
    include:
      /packages\/desktop\/(src\/main\/desktopWindowsOpenFolderContextMenu\.ts|test\/desktopDeepLinkUrl\.test\.ts)$/,
  },
  {
    id: "p0-ui-locales",
    phase: "P0",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/ui\/src\/i18n\/locales\/(en-US|zh-CN)\.ts$/,
    note: "i18n values (quoted strings only; keys never contain ZCode)",
  },
  {
    id: "p0-ui-components",
    phase: "P0",
    match: '"ZCode"',
    replace: '"MCode"',
    include:
      /packages\/ui\/src\/(WorkspaceSidebarFooter|WindowsTopLeftLogo|WelcomeScreen)\.tsx$|packages\/ui\/src\/onboarding\/OnboardingWelcomeView\.tsx$|packages\/ui\/src\/highspeed\/HighspeedShareNoticeCard\.tsx$|packages\/ui\/src\/lib\/zcodeUiError\.ts$/,
  },
  {
    id: "p0-ui-aria",
    phase: "P0",
    match: 'aria-label="ZCode"',
    replace: 'aria-label="MCode"',
    include: /packages\/ui\/src\//,
  },
  {
    id: "p0-ui-skill-i18n",
    phase: "P0",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/ui\/src\/lib\/builtinSkillI18n\.ts$/,
  },
  {
    id: "p0-web-titles",
    phase: "P0",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include:
      /packages\/web\/(index\.html|src\/main\.tsx|src\/auth\/webAuthLocale\.ts|src\/web-remote-control\/ui\/webRemoteControlBrand\.tsx|src\/web-remote-control\/ui\/webRemoteControlConnectionSheet\.tsx|src\/share\/ConversationShareLandingPage\.tsx)$|packages\/web-share\/(index\.html|src\/main\.tsx)$/,
    note: "quoted strings only - identifiers like ZCodeIntlProvider stay",
  },
  {
    id: "p0-renderer-title",
    phase: "P0",
    match: "<title>ZCode</title>",
    replace: "<title>MCode</title>",
    include: /packages\/desktop\/src\/renderer\/index\.html$/,
  },
  {
    id: "p0-process-names",
    phase: "P0",
    match: '"ZCode"',
    replace: '"MCode"',
    include: /packages\/shared\/src\/process-names\.ts$/,
  },
  {
    id: "p0-plugin-display-name",
    phase: "P0",
    match: "zcode: \"ZCode\"",
    replace: "zcode: \"MCode\"",
    include: /packages\/shared\/src\/plugin-display-name\.ts$/,
    note: "namespace key stays; display value changes",
  },
  {
    id: "p0-cli-tui",
    phase: "P0",
    match: 'PRODUCT_NAME = "ZCode"',
    replace: 'PRODUCT_NAME = "MCode"',
    include: /apps\/zcode-cli\/packages\/tui\/src\/app-sidebar\.tsx$/,
  },
  {
    id: "p0-cli-i18n",
    phase: "P0",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /apps\/zcode-cli\/packages\/i18n\/src\/locales\//,
  },
  {
    id: "p0-agent-identity",
    phase: "P0",
    match: "You are ZCode",
    replace: "You are MCode",
    include: /apps\/zcode-cli\/packages\//,
  },
  {
    id: "p0-subagent-identity",
    phase: "P0",
    match: "for ZCode CLI",
    replace: "for MCode CLI",
    include: /apps\/zcode-cli\/packages\/core\/src\/subagent\//,
  },
  {
    id: "p0-startup-marks",
    phase: "P0",
    match: "ZCode app startup",
    replace: "MCode app startup",
    include: /apps\/zcode-cli\/packages\/bootstrap\/src\//,
  },
  {
    id: "p0-bootstrap-strings",
    phase: "P0",
    match: '"ZCode ',
    replace: '"MCode ',
    include: /apps\/zcode-cli\/packages\/bootstrap\/src\//,
    note: "startup marks + runtime error strings",
  },
  {
    id: "p0-remote-window-prefix",
    phase: "P0",
    match: '"ZCode - "',
    replace: '"MCode - "',
    include: /packages\/shared\/src\/process-names\.ts$/,
  },

  // ---- P1: packaging identity ----------------------------------------------
  // appId / productName / Linux exe+package names, dev AUMID. The identity
  // module and its contract test share the same field/value literals, so one
  // include set covers both. Packaging contact metadata (homepage, author
  // email, deb maintainer) is intentionally NOT scripted: those values embed
  // the preserve-listed z.ai origin and are swapped surgically per plan.
  {
    id: "p1-identity-appid-preview",
    phase: "P1",
    match: 'appId: "dev.zcode.app.preview"',
    replace: 'appId: "dev.mcode.app.preview"',
    include: PRODUCT_IDENTITY_FILES,
  },
  {
    id: "p1-identity-appid",
    phase: "P1",
    match: 'appId: "dev.zcode.app"',
    replace: 'appId: "dev.mcode.app"',
    include: PRODUCT_IDENTITY_FILES,
  },
  {
    id: "p1-identity-product-name-preview",
    phase: "P1",
    match: 'productName: "ZCode Preview"',
    replace: 'productName: "MCode Preview"',
    include: PRODUCT_IDENTITY_FILES,
  },
  {
    id: "p1-identity-product-name",
    phase: "P1",
    match: 'productName: "ZCode"',
    replace: 'productName: "MCode"',
    include: PRODUCT_IDENTITY_FILES,
  },
  {
    id: "p1-identity-linux-preview-names",
    phase: "P1",
    match: '"zcode-preview"',
    replace: '"mcode-preview"',
    include: PRODUCT_IDENTITY_FILES,
    note: "preview linux executable + package name",
  },
  {
    id: "p1-identity-linux-executable",
    phase: "P1",
    match: 'linuxExecutableName: "zcode"',
    replace: 'linuxExecutableName: "mcode"',
    include: PRODUCT_IDENTITY_FILES,
  },
  {
    id: "p1-identity-linux-package",
    phase: "P1",
    match: 'linuxPackageName: "zcode"',
    replace: 'linuxPackageName: "mcode"',
    include: PRODUCT_IDENTITY_FILES,
  },
  {
    id: "p1-identity-dev-aumid",
    phase: "P1",
    match: '"cn.aminer.zcode"',
    replace: '"si.stumberger.mcode"',
    include: PRODUCT_IDENTITY_FILES,
    note: "dev (unpackaged) Windows AppUserModelId",
  },
  {
    id: "p1-identity-comment-strings",
    phase: "P1",
    match: new RegExp(`${QUOTED_ZCODE.source}|${BACKTICK_ZCODE.source}`),
    replaceFn: mcodeInSpan,
    include: PRODUCT_IDENTITY_FILES,
    note: "doc comments + test descriptions quoting the product name",
  },
  {
    id: "p1-builder-quoted-strings",
    phase: "P1",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/desktop\/electron-builder\.config\.js$/,
    note: "author name, productFilename fallback, Preview signing error",
  },
  {
    id: "p1-builder-template-strings",
    phase: "P1",
    match: BACKTICK_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/desktop\/electron-builder\.config\.js$/,
    note: "afterPack assertion errors",
  },
  {
    id: "p1-linux-icon-comment",
    phase: "P1",
    match: "Icon=zcode",
    replace: "Icon=mcode",
    include:
      /packages\/desktop\/(electron-builder\.config\.js|src\/main\/desktopLinuxAppImageIcon\.ts)$/,
    note: "comments describing the desktop entry Icon key",
  },
  {
    id: "p1-linux-hicolor-comment",
    phase: "P1",
    match: "apps/zcode.png",
    replace: "apps/mcode.png",
    include: /packages\/desktop\/electron-builder\.config\.js$/,
  },
  {
    id: "p1-desktop-package-json",
    phase: "P1",
    match: QUOTED_ZCODE,
    replaceFn: mcodeInSpan,
    include: /packages\/desktop\/package\.json$/,
    note: 'description/author/productName values; package name @zcode/desktop stays until P4',
  },
  {
    id: "p1-linux-desktop-entry-file",
    phase: "P1",
    match: "zcode.desktop",
    replace: "mcode.desktop",
    include:
      /packages\/desktop\/(src\/main\/desktopLinuxDeepLinkRegistration\.ts|test\/desktopLinuxDeepLinkRegistration\.test\.ts)$/,
    note: "user-level desktop entry id (constant, comments, logs) + test fixtures",
  },
  {
    id: "p1-linux-icon-default",
    phase: "P1",
    match: 'params.iconName ?? "zcode"',
    replace: 'params.iconName ?? "mcode"',
    include: /packages\/desktop\/src\/main\/desktopLinuxDeepLinkRegistration\.ts$/,
  },
  {
    id: "p1-linux-product-name-default",
    phase: "P1",
    match: 'params.productName ?? "ZCode"',
    replace: 'params.productName ?? "MCode"',
    include: /packages\/desktop\/src\/main\/desktopLinuxDeepLinkRegistration\.ts$/,
  },
  {
    id: "p1-linux-app-icon-name",
    phase: "P1",
    match: 'LINUX_APP_ICON_NAME = "zcode"',
    replace: 'LINUX_APP_ICON_NAME = "mcode"',
    include: /packages\/desktop\/src\/main\/desktopLinuxAppImageIcon\.ts$/,
    note: "hicolor icon basename must match Icon=mcode",
  },
  {
    id: "p1-linux-app-icon-test-path",
    phase: "P1",
    match: '"zcode.png"',
    replace: '"mcode.png"',
    include: /packages\/desktop\/test\/desktopLinuxDeepLinkRegistration\.test\.ts$/,
    note: "hicolor icon basename assertions follow LINUX_APP_ICON_NAME",
  },
  {
    id: "p1-builder-protocols-schemes",
    phase: "P1",
    match: 'schemes: ["zcode"],',
    replace: 'schemes: ["zcode", "mcode"],',
    include: /packages\/desktop\/electron-builder\.config\.js$/,
    note: "additive: zcode stays first; guarded by the protocols-keep-zcode postcondition",
  },
];

function parseArgs(argv) {
  const args = { phase: "all", dryRun: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--verbose") args.verbose = true;
    else if (argv[i] === "--phase") args.phase = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  return out.split("\n").filter(Boolean);
}

function isExcluded(relPath) {
  return EXCLUDED_PATHS.some((prefix) => relPath.startsWith(prefix) || relPath === prefix);
}

function applyRule(rule, content, relPath) {
  const spans = protectedRanges(content);
  const matches = [];
  if (typeof rule.match === "string") {
    for (let i = content.indexOf(rule.match); i !== -1; i = content.indexOf(rule.match, i + rule.match.length)) {
      matches.push([i, i + rule.match.length]);
    }
  } else {
    for (const m of content.matchAll(new RegExp(rule.match.source, "g"))) {
      if (m.index !== undefined) matches.push([m.index, m.index + m[0].length]);
    }
  }
  if (matches.length === 0) return { content, changed: 0 };
  for (const span of matches) {
    if (rule.replaceFn) {
      // Transform rules rewrite only the ZCode occurrences inside the span;
      // protection is checked per occurrence so a long string may also contain
      // protected literals (e.g. "... on ZCode ... https://zcode.z.ai").
      const matched = content.slice(span[0], span[1]);
      for (let i = matched.indexOf("ZCode"); i !== -1; i = matched.indexOf("ZCode", i + 1)) {
        const at = span[0] + i;
        if (overlaps([at, at + "ZCode".length], spans)) {
          throw new Error(
            `preserve violation: rule ${rule.id} in ${relPath} would rewrite a protected ZCode occurrence at ${at}`,
          );
        }
      }
    } else if (overlaps(span, spans)) {
      throw new Error(
        `preserve violation: rule ${rule.id} in ${relPath} would rewrite a protected literal at ${span[0]}..${span[1]}`,
      );
    }
  }
  // Replace from the end so earlier indices stay valid.
  let next = content;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const [s, e] = matches[i];
    const matched = content.slice(s, e);
    const replacement = rule.replaceFn ? rule.replaceFn(matched) : rule.replace;
    next = next.slice(0, s) + replacement + next.slice(e);
  }
  return { content: next, changed: matches.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const activeRules = RULES.filter((r) => args.phase === "all" || r.phase === args.phase);
  if (activeRules.length === 0) {
    console.error(`no rules for phase ${args.phase}`);
    process.exit(2);
  }
  const files = listTrackedFiles().filter((f) => !isExcluded(f) && activeRules.some((r) => r.include.test(f)));
  let totalFiles = 0;
  let totalMatches = 0;
  const report = [];
  /** Final content per file as this run leaves it (written, or unchanged). */
  const finalContents = new Map();
  for (const relPath of files) {
    const abs = join(ROOT, relPath);
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let next = content;
    let fileChanged = 0;
    for (const rule of activeRules) {
      if (!rule.include.test(relPath)) continue;
      const result = applyRule(rule, next, relPath);
      next = result.content;
      fileChanged += result.changed;
      if (result.changed > 0 && args.verbose) report.push(`${rule.id}: ${relPath} (${result.changed})`);
    }
    finalContents.set(relPath, next);
    if (fileChanged > 0 && next !== content) {
      totalFiles += 1;
      totalMatches += fileChanged;
      if (!args.dryRun) writeFileSync(abs, next);
    }
  }
  assertPostconditions(finalContents);
  console.log(
    `${args.dryRun ? "[dry-run] " : ""}phase ${args.phase}: ${totalMatches} replacements in ${totalFiles} files`,
  );
  if (args.verbose) report.forEach((line) => console.log(`  ${line}`));
}

/**
 * Post-run preserve invariants (scripts/rebrand/whitelist.mjs). Evaluated on the
 * content this run leaves behind: files this run touched use the rewritten
 * content, everything else is read from disk. Throws before exiting 0, in both
 * dry-run and apply modes, if a protected registration lost "zcode".
 */
function assertPostconditions(finalContents) {
  for (const postcondition of PRESERVE_POSTCONDITIONS) {
    const targets = listTrackedFiles().filter((f) => !isExcluded(f) && postcondition.include.test(f));
    for (const relPath of targets) {
      const content = finalContents.get(relPath) ?? readFileSync(join(ROOT, relPath), "utf8");
      if (!postcondition.assert(content)) {
        throw new Error(
          `preserve postcondition violated: ${postcondition.id} no longer holds for ${relPath}`,
        );
      }
    }
  }
}

main();
