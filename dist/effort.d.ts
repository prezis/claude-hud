export interface EffortInfo {
    level: string;
    symbol: string;
}
/**
 * Shape of the effort field in Claude Code stdin JSON.
 *
 * Historically absent; Claude Code 2.1.115+ sends an object with a string
 * `level` field (verified capture: `{ "level": "max" }`). The index signature
 * keeps the type permissive so future additions (e.g., a budget field) do not
 * require another breaking change here.
 */
export interface StdinEffort {
    level?: string | null;
    [key: string]: unknown;
}
export type StdinEffortInput = string | StdinEffort | null | undefined;
/**
 * Resolve the current session's effort level.
 *
 * Resolution order:
 * 1. stdin.effort as non-empty string — original PR #471 future-proofed path.
 * 2. stdin.effort as object with string `level` — Claude Code 2.1.115+ schema
 *    (e.g., `{ "level": "max" }`).
 * 3. Parent process CLI args — `--effort` flag captured from ppid.
 * 4. settings.json `effortLevel` — persistent project/user default. Read order:
 *    project-local (`./.claude/settings.local.json`), project (`./.claude/settings.json`),
 *    user (`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`). Most-specific wins.
 *    Useful on Claude Code < 2.1.115 (no stdin.effort) and for users who set
 *    effort persistently via settings instead of `--effort` flag.
 * 5. null.
 *
 * Non-matching inputs (numbers, booleans, arrays, objects without a string
 * `level`) fall through rather than crashing.
 */
export declare function resolveEffortLevel(stdinEffort?: StdinEffortInput, cwd?: string): EffortInfo | null;
/**
 * Read `effortLevel` from settings files. Most-specific wins.
 *
 * Search order:
 *   1. `${cwd}/.claude/settings.local.json`
 *   2. `${cwd}/.claude/settings.json`
 *   3. `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`
 *
 * Returns the first non-empty string `effortLevel` found, else null. All file
 * I/O and JSON errors are swallowed — this is a soft fallback, not a contract.
 */
export declare function readSettingsEffort(cwd?: string): string | null;
//# sourceMappingURL=effort.d.ts.map