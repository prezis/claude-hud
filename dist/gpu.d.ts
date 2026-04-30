export interface GpuDevice {
    name: string;
    utilizationPercent: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    temperatureC: number | null;
}
export type GpuConsumerKind = "ollama" | "llama-server" | "vllm" | "claude" | "bun" | "browser" | "other";
export interface GpuConsumer {
    pid: number;
    processName: string;
    /** First non-flag arg after the binary, useful for "bun run X" detection. */
    cmdline: string;
    memoryBytes: number;
    kind: GpuConsumerKind;
    /**
     * If we walked the parent chain and found a `claude` process, this is the
     * tmux session:window label of that pane (best-effort).
     */
    tmuxLabel?: string;
    /** Service-specific extras (e.g. ollama model name). */
    detail?: string;
}
export interface OllamaLoadedModel {
    name: string;
    vramBytes: number;
    expiresAt?: Date;
}
export interface ClaudeSession {
    /** tmux session:window.pane, e.g. "sol:1.0". */
    tmuxLabel?: string;
    /** Foreground command for the pane (resolved cwd or shell). */
    cwd?: string;
    pid: number;
    /** True when the claude process (or a descendant) has GPU memory allocated. */
    usingGpu: boolean;
    /** Sum of GPU memory used by claude + descendants. */
    gpuMemoryBytes: number;
}
export interface GpuStatus {
    device: GpuDevice;
    consumers: GpuConsumer[];
    ollamaModels: OllamaLoadedModel[];
    /** All claude tmux panes we could find on this host (whether GPU or CPU). */
    claudeSessions: ClaudeSession[];
    /** Wall clock when this snapshot was produced. */
    collectedAt: number;
}
export interface GpuDeps {
    /** Run a command with arguments; returns stdout. Throw to indicate failure. */
    exec: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
    /** Read a /proc file; returns null if missing/unreadable. */
    readProc: (relPath: string) => string | null;
    /** Fetch a URL with timeout; returns text body. Throw for non-2xx / network. */
    fetchText: (url: string, timeoutMs: number) => Promise<string>;
    /** Returns ms since epoch, used to time-stamp the cache. */
    now: () => number;
}
export declare function _setGpuDepsForTests(overrides: Partial<GpuDeps> | null): void;
/**
 * Parse `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader`.
 * One row per GPU, returns the first.
 */
export declare function parseGpuDevice(stdout: string): GpuDevice | null;
/**
 * Parse `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader`.
 *
 * The `process_name` column contains the full command line, so it can embed
 * commas (e.g. Chromium GPU process flags). We anchor on the leading pid and
 * the trailing ", N MiB" memory suffix, treating everything in between as the
 * process name verbatim.
 */
export declare function parseComputeApps(stdout: string): Array<{
    pid: number;
    processName: string;
    memoryBytes: number;
}>;
/** Parse the JSON returned by Ollama's /api/ps endpoint. */
export declare function parseOllamaPs(body: string): OllamaLoadedModel[];
/**
 * Classify a GPU consumer by its full process name. Heuristics, ordered most
 * specific → least specific.
 */
export declare function classifyConsumer(processName: string): GpuConsumerKind;
interface ProcInfo {
    pid: number;
    ppid: number;
    comm: string;
    cmdline: string;
}
/** Walks parents until we hit init (pid 1) or 32 hops, returns ancestry. */
export declare function walkAncestry(pid: number, d?: GpuDeps): ProcInfo[];
export declare function _resetGpuCacheForTests(): void;
export declare function collectGpuStatus(d?: GpuDeps): Promise<GpuStatus | null>;
/**
 * Cached entry-point used by the renderer. Honours `CLAUDE_HUD_GPU_REFRESH_MS`
 * (default 2000ms). Returns the previously-cached value while a fresh
 * collection is in flight to keep the per-keystroke render path snappy.
 */
export declare function getGpuStatus(): Promise<GpuStatus | null>;
/** Format bytes as a compact "X.Y GB" / "X MB" string. */
export declare function formatGpuBytes(bytes: number): string;
/** Format milliseconds-until-expiry as "5m", "1h 12m", or "expired". */
export declare function formatExpiresIn(expiresAt: Date | undefined, now: number): string | null;
export {};
//# sourceMappingURL=gpu.d.ts.map