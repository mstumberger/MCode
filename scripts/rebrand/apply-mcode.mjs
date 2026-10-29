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
import { EXCLUDED_PATHS, PRESERVE_LITERALS, PRESERVE_PATTERNS } from "./whitelist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @returns {[number, number][]} protected [start,end) ranges in `content`. */
function protectedRanges(content) {
  const ranges = [];
  for (const literal of PRESERVE_LITERALS) {
    for (let i = content.indexOf(literal); i !== -1; i = content.indexOf(literal, i + 1)) {
      ranges.push([i, i + literal.length]);
    }
  }
  for (const pattern of PRESERVE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of content.matchAll(pattern)) {
      if (m.index !== undefined) ranges.push([m.index, m.index + m[0].length]);
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
    if (fileChanged > 0 && next !== content) {
      totalFiles += 1;
      totalMatches += fileChanged;
      if (!args.dryRun) writeFileSync(abs, next);
    }
  }
  console.log(
    `${args.dryRun ? "[dry-run] " : ""}phase ${args.phase}: ${totalMatches} replacements in ${totalFiles} files`,
  );
  if (args.verbose) report.forEach((line) => console.log(`  ${line}`));
}

main();
