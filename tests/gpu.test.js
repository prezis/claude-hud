import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGpuDevice,
  parseComputeApps,
  parseOllamaPs,
  classifyConsumer,
  formatGpuBytes,
  formatExpiresIn,
  collectGpuStatus,
  _setGpuDepsForTests,
  _resetGpuCacheForTests,
} from '../dist/gpu.js';
import { formatGpuLines } from '../dist/render/lines/gpu.js';

const MIB = 1024 * 1024;

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

test('parseGpuDevice: RTX 5090 sample row', () => {
  const stdout = 'NVIDIA GeForce RTX 5090, 0 %, 31067 MiB, 32607 MiB, 41\n';
  const dev = parseGpuDevice(stdout);
  assert.equal(dev.name, 'NVIDIA GeForce RTX 5090');
  assert.equal(dev.utilizationPercent, 0);
  assert.equal(dev.memoryUsedBytes, 31067 * MIB);
  assert.equal(dev.memoryTotalBytes, 32607 * MIB);
  assert.equal(dev.temperatureC, 41);
});

test('parseGpuDevice: missing temperature column tolerated', () => {
  const stdout = 'NVIDIA RTX A2000, 47 %, 1234 MiB, 6144 MiB\n';
  const dev = parseGpuDevice(stdout);
  assert.equal(dev.temperatureC, null);
  assert.equal(dev.utilizationPercent, 47);
});

test('parseGpuDevice: empty stdout returns null', () => {
  assert.equal(parseGpuDevice(''), null);
  assert.equal(parseGpuDevice('   \n\n'), null);
});

test('parseGpuDevice: malformed row (too few cols) returns null', () => {
  assert.equal(parseGpuDevice('only-one-col\n'), null);
});

test('parseComputeApps: handles process names containing commas', () => {
  // Real Chromium row from RTX 5090 — embedded commas in --gpu-preferences flag.
  const stdout = `5954, /snap/chromium/3411/usr/lib/chromium-browser/chrome --type=gpu-process,--ozone-platform=x11,--enable-crash-reporter=?snap, 71 MiB
2111719, /home/user/.bun/bin/bun, 1974 MiB
495962, /home/user/ai/llama-turboquant/build/bin/llama-server --port 8080, 17618 MiB
3082782, /usr/local/bin/ollama, 10068 MiB
`;
  const apps = parseComputeApps(stdout);
  assert.equal(apps.length, 4);
  assert.equal(apps[0].pid, 5954);
  assert.equal(apps[0].memoryBytes, 71 * MIB);
  assert.ok(apps[0].processName.includes('chromium-browser'));
  assert.equal(apps[1].pid, 2111719);
  assert.equal(apps[2].pid, 495962);
  assert.equal(apps[2].memoryBytes, 17618 * MIB);
  assert.ok(apps[2].processName.includes('llama-server'));
  assert.equal(apps[3].processName, '/usr/local/bin/ollama');
});

test('parseComputeApps: empty stdout returns empty array', () => {
  assert.deepEqual(parseComputeApps(''), []);
});

test('parseComputeApps: malformed rows are skipped', () => {
  const stdout = `garbage line with no comma
123, valid-process, 100 MiB
not-a-pid, also bad, 50 MiB
`;
  const apps = parseComputeApps(stdout);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].pid, 123);
});

test('parseOllamaPs: real /api/ps payload', () => {
  const body = JSON.stringify({
    models: [
      {
        name: 'qwen3.5:27b',
        model: 'qwen3.5:27b',
        size: 23946335936,
        size_vram: 9363437824,
        expires_at: '2026-04-30T20:41:22.984512125+01:00',
      },
    ],
  });
  const models = parseOllamaPs(body);
  assert.equal(models.length, 1);
  assert.equal(models[0].name, 'qwen3.5:27b');
  assert.equal(models[0].vramBytes, 9363437824);
  assert.ok(models[0].expiresAt instanceof Date);
});

test('parseOllamaPs: malformed JSON returns empty array', () => {
  assert.deepEqual(parseOllamaPs(''), []);
  assert.deepEqual(parseOllamaPs('not json'), []);
  assert.deepEqual(parseOllamaPs('null'), []);
  assert.deepEqual(parseOllamaPs('{}'), []);
  assert.deepEqual(parseOllamaPs('{"models":"oops"}'), []);
});

test('classifyConsumer: well-known service binaries', () => {
  assert.equal(classifyConsumer('/usr/local/bin/ollama'), 'ollama');
  assert.equal(classifyConsumer('/home/u/ai/llama-turboquant/build/bin/llama-server'), 'llama-server');
  assert.equal(classifyConsumer('python3.11 -m vllm.entrypoints.openai.api_server'), 'vllm');
  assert.equal(classifyConsumer('/home/u/.bun/bin/bun'), 'bun');
  assert.equal(classifyConsumer('/usr/bin/chromium-browser --type=gpu-process'), 'browser');
  assert.equal(classifyConsumer('/snap/chromium/chrome'), 'browser');
  assert.equal(classifyConsumer('blender --render-frame=1'), 'other');
});

test('formatGpuBytes formats VRAM amounts in human-readable units', () => {
  assert.equal(formatGpuBytes(0), '0 MB');
  assert.equal(formatGpuBytes(50 * MIB), '50.0 MB');
  assert.equal(formatGpuBytes(500 * MIB), '500 MB');
  assert.equal(formatGpuBytes(2048 * MIB), '2.0 GB');
  assert.equal(formatGpuBytes(17618 * MIB), '17.2 GB');
});

test('formatExpiresIn: relative-time formatting', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatExpiresIn(undefined, now), null);
  assert.equal(formatExpiresIn(new Date(now - 1000), now), 'expired');
  assert.equal(formatExpiresIn(new Date(now + 30_000), now), '30s');
  assert.equal(formatExpiresIn(new Date(now + 5 * 60_000), now), '5m');
  assert.equal(formatExpiresIn(new Date(now + (60 + 12) * 60_000), now), '1h 12m');
});

test('collectGpuStatus: full happy path with mocked nvidia-smi + ollama + tmux', async () => {
  _setGpuDepsForTests({
    exec: async (cmd, args) => {
      if (cmd === 'nvidia-smi' && args[0].startsWith('--query-gpu')) {
        return 'NVIDIA GeForce RTX 5090, 4 %, 28100 MiB, 32607 MiB, 40\n';
      }
      if (cmd === 'nvidia-smi' && args[0].startsWith('--query-compute-apps')) {
        return [
          '495962, /home/u/ai/llama-turboquant/build/bin/llama-server --port 8080, 17618 MiB',
          '2111719, /home/u/.bun/bin/bun, 1974 MiB',
          '3082782, /usr/local/bin/ollama, 7100 MiB',
        ].join('\n') + '\n';
      }
      if (cmd === 'tmux') {
        // pane_pid=99999 (ancestor of 2111719), tmux session sol:1.0, command "claude"
        return [
          '99999 sol:1.0 claude /home/u/ai/smc-engine',
          '99998 sol:2.0 zsh /home/u',
        ].join('\n') + '\n';
      }
      throw new Error(`unexpected exec: ${cmd}`);
    },
    readProc: (rel) => {
      // Pretend pid 2111719 → ppid 99999, and 99999 → ppid 1 with cmdline=claude
      if (rel === '2111719/status') return 'Name:\tbun\nPPid:\t99999\n';
      if (rel === '2111719/cmdline') return '/home/u/.bun/bin/bun\0';
      if (rel === '99999/status') return 'Name:\tnode\nPPid:\t1\n';
      if (rel === '99999/cmdline') return 'node\0/home/u/.claude/local/claude\0';
      return null;
    },
    fetchText: async (url) => {
      if (url.includes('/api/ps')) {
        return JSON.stringify({
          models: [
            {
              name: 'bielik-11b-v3',
              size_vram: 7100 * MIB,
              expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    now: () => 1_700_000_000_000,
  });
  _resetGpuCacheForTests();

  const status = await collectGpuStatus();
  assert.ok(status, 'expected collectGpuStatus to return a snapshot');
  assert.equal(status.device.utilizationPercent, 4);
  assert.equal(status.device.memoryUsedBytes, 28100 * MIB);
  assert.equal(status.consumers.length, 3);

  // bun PID with claude ancestor was promoted to 'claude' kind.
  const promoted = status.consumers.find((c) => c.pid === 2111719);
  assert.equal(promoted.kind, 'claude');
  assert.equal(promoted.tmuxLabel, 'sol:1.0');

  const ollamaConsumer = status.consumers.find((c) => c.kind === 'ollama');
  assert.equal(ollamaConsumer.detail, 'bielik-11b-v3');

  const llamaConsumer = status.consumers.find((c) => c.kind === 'llama-server');
  assert.equal(llamaConsumer.detail, 'port 8080');

  assert.equal(status.ollamaModels.length, 1);
  assert.equal(status.ollamaModels[0].name, 'bielik-11b-v3');

  // Cleanup
  _setGpuDepsForTests(null);
});

test('collectGpuStatus: returns null when nvidia-smi missing', async () => {
  _setGpuDepsForTests({
    exec: async () => {
      throw new Error('ENOENT');
    },
  });
  _resetGpuCacheForTests();
  const status = await collectGpuStatus();
  assert.equal(status, null);
  _setGpuDepsForTests(null);
});

test('collectGpuStatus: ollama unavailable degrades gracefully', async () => {
  _setGpuDepsForTests({
    exec: async (cmd, args) => {
      if (args[0].startsWith('--query-gpu')) {
        return 'RTX 4090, 0 %, 100 MiB, 24576 MiB, 30\n';
      }
      return '';
    },
    fetchText: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  _resetGpuCacheForTests();
  const status = await collectGpuStatus();
  assert.ok(status);
  assert.deepEqual(status.ollamaModels, []);
  assert.deepEqual(status.consumers, []);
  _setGpuDepsForTests(null);
});

test('collectGpuStatus: respects CLAUDE_HUD_GPU_DISABLE=1', async () => {
  const prev = process.env.CLAUDE_HUD_GPU_DISABLE;
  process.env.CLAUDE_HUD_GPU_DISABLE = '1';
  _resetGpuCacheForTests();
  try {
    const status = await collectGpuStatus();
    assert.equal(status, null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_HUD_GPU_DISABLE;
    else process.env.CLAUDE_HUD_GPU_DISABLE = prev;
  }
});

test('formatGpuLines: compact mode produces a single condensed line', () => {
  const status = {
    device: {
      name: 'NVIDIA GeForce RTX 5090',
      utilizationPercent: 4,
      memoryUsedBytes: 28100 * MIB,
      memoryTotalBytes: 32607 * MIB,
      temperatureC: 40,
    },
    consumers: [
      { pid: 1, processName: 'ollama', cmdline: 'ollama', memoryBytes: 7100 * MIB, kind: 'ollama', detail: 'qwen3.5:27b' },
    ],
    ollamaModels: [],
    claudeSessions: [],
    collectedAt: 0,
  };
  const out = stripAnsi(formatGpuLines(status, true, Date.now()));
  assert.ok(out.includes('GPU'));
  assert.ok(out.includes('5090'));
  assert.ok(out.includes('4%'));
  // 28100 MiB → ~27 GB, 32607 MiB → ~32 GB
  assert.ok(/2[78]\/3[12] GB/.test(out), `expected XX/YY GB pattern, got: ${out}`);
  // Compact mode is one line.
  assert.equal(out.split('\n').length, 1);
});

test('formatGpuLines: expanded mode includes service breakdown rows', () => {
  const now = Date.now();
  const status = {
    device: {
      name: 'NVIDIA GeForce RTX 5090',
      utilizationPercent: 4,
      memoryUsedBytes: 28100 * MIB,
      memoryTotalBytes: 32607 * MIB,
      temperatureC: 40,
    },
    consumers: [
      { pid: 1, processName: 'ollama', cmdline: 'ollama', memoryBytes: 7100 * MIB, kind: 'ollama' },
      { pid: 2, processName: 'llama-server --port 8080', cmdline: 'llama-server', memoryBytes: 17618 * MIB, kind: 'llama-server', detail: 'port 8080' },
      { pid: 3, processName: 'bun', cmdline: 'bun', memoryBytes: 1974 * MIB, kind: 'claude', tmuxLabel: 'sol:1.0' },
    ],
    ollamaModels: [
      { name: 'bielik-11b-v3', vramBytes: 7100 * MIB, expiresAt: new Date(now + 5 * 60_000) },
    ],
    claudeSessions: [
      { pid: 3, tmuxLabel: 'sol:1.0', usingGpu: true, gpuMemoryBytes: 1974 * MIB },
    ],
    collectedAt: now,
  };
  const out = stripAnsi(formatGpuLines(status, false, now));
  const lines = out.split('\n');
  assert.ok(lines.length >= 4, `expected multiple lines, got: ${out}`);
  assert.ok(lines[0].includes('GPU'));
  assert.ok(out.includes('ollama'));
  assert.ok(out.includes('bielik-11b-v3'));
  assert.ok(out.includes('llama-server'));
  assert.ok(out.includes('port 8080'));
  assert.ok(out.includes('claude'));
  assert.ok(out.includes('sol:1.0'));
});

test('formatGpuLines: hides browser/other consumers when AI services are present', () => {
  const status = {
    device: { name: 'RTX 5090', utilizationPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 32607 * MIB, temperatureC: 30 },
    consumers: [
      { pid: 1, processName: 'ollama', cmdline: 'ollama', memoryBytes: 1000 * MIB, kind: 'ollama' },
      { pid: 2, processName: 'chromium', cmdline: 'chromium', memoryBytes: 1000 * MIB, kind: 'browser' },
    ],
    ollamaModels: [],
    claudeSessions: [],
    collectedAt: 0,
  };
  const out = stripAnsi(formatGpuLines(status, false, Date.now()));
  assert.ok(out.includes('ollama'));
  assert.ok(!out.includes('chromium'));
});

test('formatGpuLines: shows browser/other when no AI service is using GPU', () => {
  const status = {
    device: { name: 'RTX 5090', utilizationPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 32607 * MIB, temperatureC: 30 },
    consumers: [
      { pid: 2, processName: 'chromium', cmdline: 'chromium', memoryBytes: 1000 * MIB, kind: 'browser' },
    ],
    ollamaModels: [],
    claudeSessions: [],
    collectedAt: 0,
  };
  const out = stripAnsi(formatGpuLines(status, false, Date.now()));
  assert.ok(out.includes('chromium'));
});

test('formatGpuLines: returns empty string when status is null', () => {
  assert.equal(formatGpuLines(null, false, Date.now()), '');
});

test('formatGpuLines: surfaces "Claude sessions: CPU only" when no Claude pane has VRAM', () => {
  const status = {
    device: { name: 'RTX 5090', utilizationPercent: 0, memoryUsedBytes: 1000 * MIB, memoryTotalBytes: 32607 * MIB, temperatureC: 30 },
    consumers: [
      { pid: 1, processName: 'ollama', cmdline: 'ollama', memoryBytes: 1000 * MIB, kind: 'ollama' },
    ],
    ollamaModels: [],
    claudeSessions: [
      { pid: 100, tmuxLabel: 'sol:1.0', usingGpu: false, gpuMemoryBytes: 0 },
      { pid: 200, tmuxLabel: 'sol:2.0', usingGpu: false, gpuMemoryBytes: 0 },
    ],
    collectedAt: 0,
  };
  const out = stripAnsi(formatGpuLines(status, false, Date.now()));
  assert.ok(out.includes('Claude sessions:'));
  assert.ok(out.includes('sol:1.0'));
  assert.ok(out.includes('sol:2.0'));
  assert.ok(out.includes('CPU only'));
});
