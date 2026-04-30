// GPU monitor panel — NVIDIA + Ollama / llama-server / vLLM detection.
//
// Design notes:
//   * All command + filesystem + network access is funnelled through small
//     dependency-injection seams (`_setGpuDepsForTests`) so the parser can be
//     covered with hermetic unit tests against canned nvidia-smi output.
//   * A coarse 2-second cache (configurable via `CLAUDE_HUD_GPU_REFRESH_MS`)
//     guards against the statusline being invoked every ~300ms — `nvidia-smi`
//     itself wakes the GPU's PMU and we do not want to spam it.
//   * Every external interaction degrades silently. If `nvidia-smi` is missing,
//     ollama isn't listening, /proc lookups race a vanishing PID, etc.,
//     `getGpuStatus` returns `null` and the panel is hidden.
//   * Uses `execFile` from node:child_process — argv is a literal string array,
//     no shell interpolation, all argv is hardcoded constants.
import * as child from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
const runFile = promisify(child.execFile);
const defaultDeps = {
    exec: async (cmd, args, timeoutMs) => {
        const { stdout } = await runFile(cmd, args, {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
        });
        return stdout;
    },
    readProc: (relPath) => {
        try {
            return fs.readFileSync(path.join("/proc", relPath), "utf8");
        }
        catch {
            return null;
        }
    },
    fetchText: async (url, timeoutMs) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            return await res.text();
        }
        finally {
            clearTimeout(timer);
        }
    },
    now: () => Date.now(),
};
let deps = defaultDeps;
export function _setGpuDepsForTests(overrides) {
    deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
    cache = null;
}
// ---------------------------------------------------------------------------
// Parsers (pure functions — these are the unit-test surface)
// ---------------------------------------------------------------------------
const MIB = 1024 * 1024;
function parseMib(token) {
    const match = token.trim().match(/(-?\d+(?:\.\d+)?)/);
    if (!match)
        return 0;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value))
        return 0;
    return Math.round(value * MIB);
}
function parsePercent(token) {
    const match = token.trim().match(/(-?\d+(?:\.\d+)?)/);
    if (!match)
        return 0;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(100, value));
}
function parseTempC(token) {
    const cleaned = token.trim();
    if (!cleaned || cleaned === "[Not Supported]" || cleaned === "N/A")
        return null;
    const match = cleaned.match(/(-?\d+(?:\.\d+)?)/);
    if (!match)
        return null;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
}
/**
 * Parse `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader`.
 * One row per GPU, returns the first.
 */
export function parseGpuDevice(stdout) {
    const firstRow = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstRow)
        return null;
    const cols = firstRow.split(",").map((c) => c.trim());
    if (cols.length < 4)
        return null;
    return {
        name: cols[0] || "GPU",
        utilizationPercent: parsePercent(cols[1] ?? "0"),
        memoryUsedBytes: parseMib(cols[2] ?? "0"),
        memoryTotalBytes: parseMib(cols[3] ?? "0"),
        temperatureC: cols.length >= 5 ? parseTempC(cols[4] ?? "") : null,
    };
}
/**
 * Parse `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader`.
 *
 * The `process_name` column contains the full command line, so it can embed
 * commas (e.g. Chromium GPU process flags). We anchor on the leading pid and
 * the trailing ", N MiB" memory suffix, treating everything in between as the
 * process name verbatim.
 */
export function parseComputeApps(stdout) {
    const rows = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const tailMatch = line.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*(MiB|MB|KiB|GiB)?\s*$/i);
        if (!tailMatch)
            continue;
        const memToken = tailMatch[0].replace(/^,\s*/, "");
        const memoryBytes = parseMib(memToken);
        const headBody = line.slice(0, line.length - tailMatch[0].length);
        const firstComma = headBody.indexOf(",");
        if (firstComma < 0)
            continue;
        const pid = Number.parseInt(headBody.slice(0, firstComma).trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0)
            continue;
        const processName = headBody.slice(firstComma + 1).trim();
        rows.push({ pid, processName, memoryBytes });
    }
    return rows;
}
/** Parse the JSON returned by Ollama's /api/ps endpoint. */
export function parseOllamaPs(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return [];
    }
    if (!parsed || typeof parsed !== "object")
        return [];
    const models = parsed.models;
    if (!Array.isArray(models))
        return [];
    const out = [];
    for (const raw of models) {
        if (!raw || typeof raw !== "object")
            continue;
        const m = raw;
        const name = typeof m.name === "string" ? m.name : (typeof m.model === "string" ? m.model : null);
        if (!name)
            continue;
        const vramRaw = m.size_vram ?? m.size;
        const vramBytes = typeof vramRaw === "number" && Number.isFinite(vramRaw) ? vramRaw : 0;
        let expiresAt;
        if (typeof m.expires_at === "string") {
            const date = new Date(m.expires_at);
            if (!Number.isNaN(date.getTime())) {
                expiresAt = date;
            }
        }
        out.push({ name, vramBytes, expiresAt });
    }
    return out;
}
/**
 * Classify a GPU consumer by its full process name. Heuristics, ordered most
 * specific → least specific.
 */
export function classifyConsumer(processName) {
    const lower = processName.toLowerCase();
    if (lower.includes("llama-server") || lower.includes("llama_cpp_server"))
        return "llama-server";
    if (lower.endsWith("/ollama") || lower.endsWith("ollama") || lower.includes("/ollama "))
        return "ollama";
    if (lower.includes("vllm") || /python[0-9.]*\b.*vllm/.test(lower))
        return "vllm";
    if (lower.includes("/claude") || lower.endsWith(" claude") || /\bclaude\b.*\bcli\b/.test(lower))
        return "claude";
    if (/\bchrome\b/.test(lower) || /\bchromium\b/.test(lower) || /electron/.test(lower) || /firefox/.test(lower))
        return "browser";
    if (/\bbun\b/.test(lower) || /\bnode\b/.test(lower))
        return "bun";
    return "other";
}
function readProcInfo(pid, d = deps) {
    const status = d.readProc(`${pid}/status`);
    if (!status)
        return null;
    const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
    const commMatch = status.match(/^Name:\s+(.+)$/m);
    const cmdlineRaw = d.readProc(`${pid}/cmdline`) ?? "";
    const cmdline = cmdlineRaw.replace(/\0+$/, "").replace(/\0/g, " ").trim();
    return {
        pid,
        ppid: ppidMatch ? Number.parseInt(ppidMatch[1], 10) : 0,
        comm: commMatch ? commMatch[1].trim() : "",
        cmdline,
    };
}
/** Walks parents until we hit init (pid 1) or 32 hops, returns ancestry. */
export function walkAncestry(pid, d = deps) {
    const chain = [];
    let current = pid;
    for (let i = 0; i < 32 && current > 1; i++) {
        const info = readProcInfo(current, d);
        if (!info)
            break;
        chain.push(info);
        if (info.ppid === current)
            break;
        current = info.ppid;
    }
    return chain;
}
function isClaudeProc(info) {
    const cmd = info.cmdline.toLowerCase();
    if (/(^|\s|\/)claude(\s|$)/.test(cmd))
        return true;
    if (cmd.includes("/.claude/local/"))
        return true;
    if (cmd.includes("@anthropic-ai/claude-code"))
        return true;
    if (cmd.includes("anthropic-ai/claude"))
        return true;
    if (info.comm === "claude")
        return true;
    return false;
}
/**
 * Best-effort: returns the tmux session:window label for the pane whose
 * pane_pid is the closest ancestor of `pid`. Returns undefined when tmux is
 * not running or the lookup fails.
 */
async function resolveTmuxLabel(ancestorPids, d) {
    if (ancestorPids.length === 0)
        return undefined;
    let stdout;
    try {
        stdout = await d.exec("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{session_name}:#{window_index}.#{pane_index} #{pane_current_command}"], 1000);
    }
    catch {
        return undefined;
    }
    const panePidToLabel = new Map();
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const match = trimmed.match(/^(\d+)\s+(\S+)/);
        if (!match)
            continue;
        panePidToLabel.set(Number.parseInt(match[1], 10), match[2]);
    }
    for (const pid of ancestorPids) {
        const label = panePidToLabel.get(pid);
        if (label)
            return label;
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Top-level collection
// ---------------------------------------------------------------------------
const DEFAULT_REFRESH_MS = 2000;
let cache = null;
function getRefreshMs() {
    const raw = process.env.CLAUDE_HUD_GPU_REFRESH_MS;
    if (!raw)
        return DEFAULT_REFRESH_MS;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 250)
        return DEFAULT_REFRESH_MS;
    return Math.min(value, 60_000);
}
export function _resetGpuCacheForTests() {
    cache = null;
}
async function collectClaudeSessions(consumers, d) {
    const sessionsByPid = new Map();
    for (const consumer of consumers) {
        if (consumer.kind !== "claude")
            continue;
        sessionsByPid.set(consumer.pid, {
            pid: consumer.pid,
            tmuxLabel: consumer.tmuxLabel,
            usingGpu: consumer.memoryBytes > 0,
            gpuMemoryBytes: consumer.memoryBytes,
        });
    }
    let stdout;
    try {
        stdout = await d.exec("tmux", [
            "list-panes",
            "-a",
            "-F",
            "#{pane_pid} #{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_current_path}",
        ], 1000);
    }
    catch {
        return Array.from(sessionsByPid.values());
    }
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 3)
            continue;
        const panePid = Number.parseInt(parts[0], 10);
        const tmuxLabel = parts[1];
        const cmd = parts[2] ?? "";
        const cwd = parts.slice(3).join(" ");
        if (!Number.isFinite(panePid) || panePid <= 0)
            continue;
        const cmdLower = cmd.toLowerCase();
        if (!cmdLower.includes("claude") && !cmdLower.includes("node") && !cmdLower.includes("bun")) {
            continue;
        }
        const info = readProcInfo(panePid, d);
        const claudeAncestor = info && isClaudeProc(info);
        if (!claudeAncestor)
            continue;
        if (!sessionsByPid.has(panePid)) {
            sessionsByPid.set(panePid, {
                pid: panePid,
                tmuxLabel,
                cwd: cwd || undefined,
                usingGpu: false,
                gpuMemoryBytes: 0,
            });
        }
        else {
            const existing = sessionsByPid.get(panePid);
            if (existing && !existing.cwd)
                existing.cwd = cwd || undefined;
            if (existing && !existing.tmuxLabel)
                existing.tmuxLabel = tmuxLabel;
        }
    }
    return Array.from(sessionsByPid.values());
}
export async function collectGpuStatus(d = deps) {
    if (process.env.CLAUDE_HUD_GPU_DISABLE === "1")
        return null;
    let deviceStdout;
    try {
        deviceStdout = await d.exec("nvidia-smi", [
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader",
        ], 2000);
    }
    catch {
        return null;
    }
    const device = parseGpuDevice(deviceStdout);
    if (!device)
        return null;
    let appsStdout = "";
    try {
        appsStdout = await d.exec("nvidia-smi", [
            "--query-compute-apps=pid,process_name,used_memory",
            "--format=csv,noheader",
        ], 2000);
    }
    catch {
        appsStdout = "";
    }
    const apps = parseComputeApps(appsStdout);
    const consumers = [];
    for (const app of apps) {
        const kind = classifyConsumer(app.processName);
        let tmuxLabel;
        if (kind === "claude" || kind === "bun") {
            const ancestry = walkAncestry(app.pid, d);
            const ancestorPids = ancestry.map((info) => info.pid);
            tmuxLabel = await resolveTmuxLabel(ancestorPids, d);
            if (kind === "bun") {
                const claudeHit = ancestry.some(isClaudeProc);
                if (claudeHit) {
                    consumers.push({
                        pid: app.pid,
                        processName: app.processName,
                        cmdline: ancestry[0]?.cmdline ?? app.processName,
                        memoryBytes: app.memoryBytes,
                        kind: "claude",
                        tmuxLabel,
                    });
                    continue;
                }
            }
        }
        consumers.push({
            pid: app.pid,
            processName: app.processName,
            cmdline: app.processName,
            memoryBytes: app.memoryBytes,
            kind,
            tmuxLabel,
        });
    }
    let ollamaModels = [];
    try {
        const body = await d.fetchText("http://127.0.0.1:11434/api/ps", 1000);
        ollamaModels = parseOllamaPs(body);
    }
    catch {
        ollamaModels = [];
    }
    if (ollamaModels.length > 0) {
        for (const consumer of consumers) {
            if (consumer.kind !== "ollama" || consumer.detail)
                continue;
            const top = ollamaModels[0];
            consumer.detail = `${top.name}`;
        }
    }
    for (const consumer of consumers) {
        if (consumer.kind !== "llama-server")
            continue;
        // Try the process_name first; nvidia-smi sometimes truncates that to the
        // binary path, so fall back to /proc/<pid>/cmdline for the full argv.
        let portMatch = consumer.processName.match(/--port[\s=](\d+)/);
        if (!portMatch) {
            const info = readProcInfo(consumer.pid, d);
            if (info) {
                portMatch = info.cmdline.match(/--port[\s=](\d+)/);
                consumer.cmdline = info.cmdline || consumer.cmdline;
            }
        }
        if (portMatch)
            consumer.detail = `port ${portMatch[1]}`;
    }
    const claudeSessions = await collectClaudeSessions(consumers, d);
    return {
        device,
        consumers,
        ollamaModels,
        claudeSessions,
        collectedAt: d.now(),
    };
}
let inflight = null;
/**
 * Cached entry-point used by the renderer. Honours `CLAUDE_HUD_GPU_REFRESH_MS`
 * (default 2000ms). Returns the previously-cached value while a fresh
 * collection is in flight to keep the per-keystroke render path snappy.
 */
export async function getGpuStatus() {
    if (process.env.CLAUDE_HUD_GPU_DISABLE === "1")
        return null;
    const now = deps.now();
    if (cache && cache.expiresAt > now)
        return cache.status;
    if (inflight) {
        if (cache)
            return cache.status;
        return inflight;
    }
    const ttl = getRefreshMs();
    inflight = (async () => {
        try {
            const status = await collectGpuStatus(deps);
            cache = { status, expiresAt: deps.now() + ttl };
            return status;
        }
        catch {
            cache = { status: null, expiresAt: deps.now() + ttl };
            return null;
        }
        finally {
            inflight = null;
        }
    })();
    return inflight;
}
/** Format bytes as a compact "X.Y GB" / "X MB" string. */
export function formatGpuBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return "0 MB";
    const mib = bytes / MIB;
    if (mib >= 1024)
        return `${(mib / 1024).toFixed(1)} GB`;
    if (mib >= 100)
        return `${Math.round(mib)} MB`;
    return `${mib.toFixed(1)} MB`;
}
/** Format milliseconds-until-expiry as "5m", "1h 12m", or "expired". */
export function formatExpiresIn(expiresAt, now) {
    if (!expiresAt)
        return null;
    const diffMs = expiresAt.getTime() - now;
    if (diffMs <= 0)
        return "expired";
    const totalSec = Math.floor(diffMs / 1000);
    if (totalSec < 60)
        return `${totalSec}s`;
    const totalMin = Math.floor(totalSec / 60);
    if (totalMin < 60)
        return `${totalMin}m`;
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return `${hours}h ${mins}m`;
}
//# sourceMappingURL=gpu.js.map