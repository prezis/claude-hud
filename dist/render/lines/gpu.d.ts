import type { RenderContext } from "../../types.js";
import type { GpuStatus } from "../../gpu.js";
/**
 * Compose the GPU panel as one or more lines. Returns an empty string when
 * nothing should be rendered (no NVIDIA, panel disabled, etc.).
 */
export declare function formatGpuLines(status: GpuStatus | null, compact: boolean, now: number): string;
export declare function renderGpuLine(ctx: RenderContext, status: GpuStatus | null): string | null;
//# sourceMappingURL=gpu.d.ts.map