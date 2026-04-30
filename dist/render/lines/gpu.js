import { formatGpuBytes, formatExpiresIn } from "../../gpu.js";
import { dim, label, getQuotaColor, quotaBar, RESET } from "../colors.js";
import { getAdaptiveBarWidth } from "../../utils/terminal.js";
const MIB = 1024 * 1024;
function shortDeviceName(name) {
    // "NVIDIA GeForce RTX 5090" → "5090"
    const rtxMatch = name.match(/RTX\s*(\w+)/i);
    if (rtxMatch)
        return rtxMatch[1];
    const gtxMatch = name.match(/GTX\s*(\w+)/i);
    if (gtxMatch)
        return gtxMatch[1];
    // Strip vendor prefix.
    return name.replace(/^(NVIDIA|GeForce)\s+/i, "");
}
function formatGigabytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return "0";
    const gb = bytes / MIB / 1024;
    if (gb >= 10)
        return gb.toFixed(0);
    return gb.toFixed(1);
}
function groupConsumers(consumers) {
    const grouped = {
        ollama: [], llamaServer: [], vllm: [], claude: [], bun: [], browser: [], other: [],
    };
    for (const c of consumers) {
        switch (c.kind) {
            case "ollama":
                grouped.ollama.push(c);
                break;
            case "llama-server":
                grouped.llamaServer.push(c);
                break;
            case "vllm":
                grouped.vllm.push(c);
                break;
            case "claude":
                grouped.claude.push(c);
                break;
            case "bun":
                grouped.bun.push(c);
                break;
            case "browser":
                grouped.browser.push(c);
                break;
            default:
                grouped.other.push(c);
                break;
        }
    }
    return grouped;
}
function renderHeaderLine(status, compact) {
    const dev = status.device;
    const memUsedGb = formatGigabytes(dev.memoryUsedBytes);
    const memTotalGb = formatGigabytes(dev.memoryTotalBytes);
    const memPercent = dev.memoryTotalBytes > 0
        ? Math.round((dev.memoryUsedBytes / dev.memoryTotalBytes) * 100)
        : 0;
    const utilColor = getQuotaColor(dev.utilizationPercent);
    const memColor = getQuotaColor(memPercent);
    const gpuLabel = label("GPU");
    const shortName = shortDeviceName(dev.name);
    if (compact) {
        const procCount = status.consumers.length;
        const procBlurb = procCount === 0 ? "idle" : `${procCount} proc${procCount === 1 ? "" : "s"}`;
        return `${gpuLabel} ${dim(shortName)} ${utilColor}${dev.utilizationPercent}%${RESET} · ${memColor}${memUsedGb}/${memTotalGb} GB${RESET} · ${dim(procBlurb)}`;
    }
    const barWidth = Math.max(4, Math.floor(getAdaptiveBarWidth() / 2));
    const utilBar = quotaBar(dev.utilizationPercent, barWidth);
    const utilPart = `${utilBar} ${utilColor}${dev.utilizationPercent}%${RESET}`;
    const memPart = `${memColor}${memUsedGb}/${memTotalGb} GB${RESET}`;
    const tempPart = dev.temperatureC !== null ? ` · ${dim(`${Math.round(dev.temperatureC)}°C`)}` : "";
    return `${gpuLabel} ${dim(shortName)} ${utilPart} · ${memPart}${tempPart}`;
}
function renderConsumerRow(line) {
    return `  ${dim("↳")} ${line}`;
}
function describeOllama(c, status, now) {
    const detail = c.detail ?? (status.ollamaModels[0]?.name ?? "");
    const vramText = c.memoryBytes > 0 ? formatGpuBytes(c.memoryBytes) : "0 MB";
    const ttl = formatExpiresIn(status.ollamaModels[0]?.expiresAt, now);
    const ttlPart = ttl ? ` · ${dim(`expires in ${ttl}`)}` : "";
    const modelPart = detail ? ` · ${detail}` : "";
    return `${dim("ollama")}${modelPart} · ${vramText}${ttlPart}`;
}
function describeLlamaServer(c) {
    const portPart = c.detail ? ` · ${dim(c.detail)}` : "";
    return `${dim("llama-server")} · ${formatGpuBytes(c.memoryBytes)}${portPart}`;
}
function describeVllm(c) {
    return `${dim("vllm")} · ${formatGpuBytes(c.memoryBytes)} · ${dim(`pid ${c.pid}`)}`;
}
function describeClaude(c) {
    const tmux = c.tmuxLabel ? ` ${dim(`(${c.tmuxLabel})`)}` : "";
    return `${dim("claude")}${tmux} · ${formatGpuBytes(c.memoryBytes)} · ${dim(`pid ${c.pid}`)}`;
}
function describeBun(c) {
    const tmux = c.tmuxLabel ? ` ${dim(`(${c.tmuxLabel})`)}` : "";
    return `${dim("bun")}${tmux} · ${formatGpuBytes(c.memoryBytes)} · ${dim(`pid ${c.pid}`)} (no claude session)`;
}
function describeBrowser(c) {
    const lower = c.processName.toLowerCase();
    let bin = "browser";
    if (lower.includes("playwright"))
        bin = "playwright";
    else if (lower.includes("chromium"))
        bin = "chromium";
    else if (lower.includes("chrome"))
        bin = "chrome";
    else if (lower.includes("electron"))
        bin = "electron";
    else if (lower.includes("firefox"))
        bin = "firefox";
    return `${dim(bin)} · ${formatGpuBytes(c.memoryBytes)} · ${dim(`pid ${c.pid}`)}`;
}
function describeOther(c) {
    // Trim the binary path to the basename for readability.
    const head = c.processName.split(/[\s,]/, 1)[0] ?? c.processName;
    const segments = head.split("/");
    const bin = segments[segments.length - 1] || head;
    return `${dim(bin)} · ${formatGpuBytes(c.memoryBytes)} · ${dim(`pid ${c.pid}`)}`;
}
function describeClaudeSession(session) {
    const labelText = session.tmuxLabel ?? `pid ${session.pid}`;
    if (session.usingGpu) {
        return `${dim("Claude session")} ${labelText} · ${formatGpuBytes(session.gpuMemoryBytes)}`;
    }
    return `${dim("Claude session")} ${labelText} · ${dim("CPU only")}`;
}
/**
 * Compose the GPU panel as one or more lines. Returns an empty string when
 * nothing should be rendered (no NVIDIA, panel disabled, etc.).
 */
export function formatGpuLines(status, compact, now) {
    if (!status)
        return "";
    const headerLine = renderHeaderLine(status, compact);
    if (compact)
        return headerLine;
    const lines = [headerLine];
    const grouped = groupConsumers(status.consumers);
    for (const c of grouped.ollama) {
        lines.push(renderConsumerRow(describeOllama(c, status, now)));
    }
    for (const c of grouped.llamaServer) {
        lines.push(renderConsumerRow(describeLlamaServer(c)));
    }
    for (const c of grouped.vllm) {
        lines.push(renderConsumerRow(describeVllm(c)));
    }
    for (const c of grouped.claude) {
        lines.push(renderConsumerRow(describeClaude(c)));
    }
    for (const c of grouped.bun) {
        lines.push(renderConsumerRow(describeBun(c)));
    }
    // Browser + other are typically uninteresting noise; only show if
    // they're using > 256 MiB and there are no AI consumers (so the user knows
    // who's holding VRAM on an otherwise-quiet GPU).
    const hasAiConsumer = grouped.ollama.length + grouped.llamaServer.length + grouped.vllm.length > 0;
    for (const c of grouped.browser) {
        if (!hasAiConsumer && c.memoryBytes > 256 * MIB) {
            lines.push(renderConsumerRow(describeBrowser(c)));
        }
    }
    for (const c of grouped.other) {
        if (!hasAiConsumer && c.memoryBytes > 256 * MIB) {
            lines.push(renderConsumerRow(describeOther(c)));
        }
    }
    // Claude session summary line — only show when:
    //   * NO Claude pane is currently a GPU consumer (so the user knows: CPU
    //     only, panel still informative), OR
    //   * there are claude sessions on this host that DON'T appear in the
    //     consumer list above (CPU-only panes alongside GPU ones).
    const cpuOnlySessions = status.claudeSessions.filter((s) => !s.usingGpu);
    const gpuSessions = status.claudeSessions.filter((s) => s.usingGpu);
    if (gpuSessions.length === 0 && cpuOnlySessions.length > 0) {
        const labels = cpuOnlySessions
            .map((s) => s.tmuxLabel ?? `pid ${s.pid}`)
            .slice(0, 4)
            .join(", ");
        const more = cpuOnlySessions.length > 4 ? ` +${cpuOnlySessions.length - 4}` : "";
        lines.push(renderConsumerRow(`${dim("Claude sessions:")} ${labels}${more} · ${dim("CPU only")}`));
    }
    else if (cpuOnlySessions.length > 0) {
        // Some Claude panes use GPU (already listed above), but others are CPU only.
        const labels = cpuOnlySessions
            .map((s) => s.tmuxLabel ?? `pid ${s.pid}`)
            .slice(0, 4)
            .join(", ");
        const more = cpuOnlySessions.length > 4 ? ` +${cpuOnlySessions.length - 4}` : "";
        lines.push(renderConsumerRow(`${dim("Claude (CPU only):")} ${labels}${more}`));
    }
    // Note: gpuSessions are intentionally NOT re-listed — they already appear
    // as `claude` consumer rows above, with VRAM + tmux label.
    return lines.join("\n");
}
export function renderGpuLine(ctx, status) {
    const display = ctx.config?.display;
    if (display?.showGpu !== true)
        return null;
    if (!status)
        return null;
    const compact = process.env.CLAUDE_HUD_GPU_COMPACT === "1" || ctx.config?.lineLayout === "compact";
    const out = formatGpuLines(status, compact, Date.now());
    return out || null;
}
//# sourceMappingURL=gpu.js.map