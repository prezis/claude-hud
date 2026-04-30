import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { getClaudeConfigDir } from './claude-config-dir.js';
const KNOWN_SYMBOLS = {
    low: '○',
    medium: '◔',
    high: '◑',
    xhigh: '◕',
    max: '●',
};
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
export function resolveEffortLevel(stdinEffort, cwd) {
    const fromStdin = extractEffortString(stdinEffort);
    if (fromStdin) {
        return formatEffort(fromStdin);
    }
    const cliEffort = readParentProcessEffort();
    if (cliEffort) {
        return formatEffort(cliEffort);
    }
    const settingsEffort = readSettingsEffort(cwd);
    if (settingsEffort) {
        return formatEffort(settingsEffort);
    }
    return null;
}
function extractEffortString(value) {
    if (typeof value === 'string') {
        return value.length > 0 ? value : null;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const level = value.level;
        if (typeof level === 'string' && level.length > 0) {
            return level;
        }
    }
    return null;
}
function formatEffort(level) {
    const normalized = level.toLowerCase().trim();
    const symbol = KNOWN_SYMBOLS[normalized] ?? '';
    return { level: normalized, symbol };
}
function readParentProcessEffort() {
    if (process.platform === 'win32') {
        return null;
    }
    try {
        const ppid = process.ppid;
        if (!ppid || ppid <= 1) {
            return null;
        }
        const output = execFileSync('ps', ['-o', 'args=', '-p', String(ppid)], {
            encoding: 'utf8',
            timeout: 500,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const match = output.match(/--effort[= ]+(\w+)/);
        return match?.[1] ?? null;
    }
    catch {
        return null;
    }
}
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
export function readSettingsEffort(cwd) {
    const candidates = [];
    const workingDir = cwd ?? process.cwd();
    if (workingDir) {
        candidates.push(path.join(workingDir, '.claude', 'settings.local.json'));
        candidates.push(path.join(workingDir, '.claude', 'settings.json'));
    }
    try {
        candidates.push(path.join(getClaudeConfigDir(homedir()), 'settings.json'));
    }
    catch {
        // homedir resolution failure — fall through, candidates already populated
    }
    for (const candidate of candidates) {
        try {
            const raw = readFileSync(candidate, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed.effortLevel === 'string' && parsed.effortLevel.length > 0) {
                return parsed.effortLevel;
            }
        }
        catch {
            // Missing file, parse error, or non-string effortLevel — try next candidate.
        }
    }
    return null;
}
//# sourceMappingURL=effort.js.map