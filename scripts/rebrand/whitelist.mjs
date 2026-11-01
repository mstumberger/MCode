/**
 * Preserve list for the MCode rebrand (source of truth:
 * docs/superpowers/specs/2026-10-29-mcode-deep-rebrand-design.md).
 *
 * These literals MUST NOT be rewritten by scripts/rebrand/apply-mcode.mjs.
 * They are external contracts: z.ai backend/OAuth, credential derivation,
 * wire protocol, plugin ecosystem, and the public page API surface.
 */

/** Exact substrings that must survive every rewrite untouched. */
export const PRESERVE_LITERALS = [
  // z.ai backend origins, paths and CDN.
  "zcode.z.ai",
  "/api/v1/zcode-plan",
  // OAuth (registered server-side).
  "client_P8X5CMWmlaRO9gyO-KSqtg",
  "zcode://oauth/callback",
  // Credential cipher derivation literal (hashed into the AES key).
  "zcode-credential-fallback:",
  // Wire protocol literals.
  '"ZCode Protocol"',
  // MCP auth type + meta keys (persisted / external).
  "zcode_official",
  "zcode/errorPresentation",
  "zcode/browserScreenshotContentIndices",
  "zcode/nodeReplCuaApp",
  "zcode/officialMcpServerRequestId",
  // Plugin ecosystem stable ids.
  "zcode-plugins-official",
  // Backend contract headers.
  "x-zcode-intranet-token",
  "x-zcode-rpc-client-mode",
  "x-zcode-rpc-host-capability",
  // Public page API DOM events (window bridge surface, kept until P6).
  '"zcode:error"',
  '"zcode:set_globals"',
  '"zcode:globals"',
];

/**
 * Post-run invariants checked AFTER rules apply (and on --dry-run): file-content
 * assertions that must hold once the rebrand layer has run. Used where span
 * protection is too blunt: the deep-link registration is ADDITIVE (mcode:// is
 * registered alongside zcode://), so a rule may touch those lines, but "zcode"
 * must never drop out of the registration (spec Preserve list item 7).
 */
export const PRESERVE_POSTCONDITIONS = [
  {
    id: "electron-builder-protocols-keep-zcode-scheme",
    include: /packages\/desktop\/electron-builder\.config\.js$/,
    assert: (content) => /schemes:\s*\[[^\]]*"zcode"[^\]]*\]/.test(content),
  },
  {
    id: "linux-deep-link-registration-keep-zcode-mime",
    include: /packages\/desktop\/src\/main\/desktopLinuxDeepLinkRegistration\.ts$/,
    assert: (content) => content.includes("x-scheme-handler/zcode"),
  },
];

/**
 * Files (repo-relative prefixes) the rewriter never touches at all.
 * Docs that quote preserve-list literals verbatim, lockfile, generated dirs.
 */
export const EXCLUDED_PATHS = [
  "pnpm-lock.yaml",
  "docs/superpowers/specs/2026-10-29-mcode-deep-rebrand-design.md",
  "docs/superpowers/plans/2026-10-29-mcode-deep-rebrand.md",
  "scripts/rebrand/",
];
