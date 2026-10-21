import { execFile } from 'node:child_process';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { fetchOllamaPs, type OllamaLoadedModel } from '../ollama.js';

export interface CpuSample {
  idle: number;
  total: number;
}

export interface GpuSnapshot {
  index: number;
  name: string;
  /** Percent, 0-100. */
  utilization: number;
  /** Bytes. */
  memoryUsed: number;
  /** Bytes. */
  memoryTotal: number;
}

export interface ResourceSnapshot {
  at: number;
  cpu: { usage: number | null; cores: number };
  memory: { used: number; total: number };
  gpu: GpuSnapshot[] | null;
  ollama: OllamaLoadedModel[] | null;
  load: number[] | null;
}

function readCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function run(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) resolve(null);
        else resolve(String(stdout));
      },
    );
  });
}

const GPU_QUERY = 'index,name,utilization.gpu,memory.used,memory.total';
const GPU_RECHECK_MS = 30000;

let gpuSupported: boolean | null = null;
let gpuCheckedAt = 0;

/** Reads NVIDIA telemetry via nvidia-smi. Returns null when no NVIDIA GPU is present. */
export async function sampleGpu(timeoutMs = 1500): Promise<GpuSnapshot[] | null> {
  const now = Date.now();
  if (gpuSupported === false && now - gpuCheckedAt < GPU_RECHECK_MS) return null;

  const output = await run(
    'nvidia-smi',
    [`--query-gpu=${GPU_QUERY}`, '--format=csv,noheader,nounits'],
    timeoutMs,
  );

  if (output === null) {
    gpuSupported = false;
    gpuCheckedAt = now;
    return null;
  }

  gpuSupported = true;
  gpuCheckedAt = now;

  const gpus: GpuSnapshot[] = [];
  for (const line of output.split('\n')) {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 5) continue;
    const [index, name, utilization, used, total] = parts;
    if (!name) continue;
    gpus.push({
      index: Number(index ?? 0) || 0,
      name,
      utilization: clampPercent(Number(utilization)),
      memoryUsed: (Number(used) || 0) * 1024 * 1024,
      memoryTotal: (Number(total) || 0) * 1024 * 1024,
    });
  }

  return gpus.length > 0 ? gpus : null;
}

export interface ResourceMonitorOptions {
  /** Ollama native base URL (without `/v1`). Omit when the provider is not Ollama. */
  ollamaBaseURL?: string;
  /** Set to false to skip nvidia-smi entirely. */
  gpu?: boolean;
}

/**
 * Samples CPU, memory, GPU and (when Ollama is the provider) VRAM usage.
 * Sampling is cheap but nvidia-smi is a process spawn, so it is polled at the
 * interval the UI asks for and never overlaps with itself.
 */
export class ResourceMonitor {
  private lastCpu = readCpu();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private ollamaBase?: string;
  private readonly gpu: boolean;

  constructor(options: ResourceMonitorOptions = {}) {
    this.ollamaBase = options.ollamaBaseURL;
    this.gpu = options.gpu ?? true;
  }

  /** Called when the provider changes at runtime. */
  setOllamaBaseURL(base?: string): void {
    this.ollamaBase = base;
  }

  async sample(): Promise<ResourceSnapshot> {
    const current = readCpu();
    const totalDelta = current.total - this.lastCpu.total;
    const idleDelta = current.idle - this.lastCpu.idle;
    this.lastCpu = current;

    const usage = totalDelta > 0 ? clampPercent((1 - idleDelta / totalDelta) * 100) : null;
    const memoryTotal = totalmem();
    const memory = { used: memoryTotal - freemem(), total: memoryTotal };

    const ollamaBase = this.ollamaBase;
    const [gpu, ollama] = await Promise.all([
      this.gpu ? sampleGpu() : Promise.resolve(null),
      ollamaBase ? fetchOllamaPs(ollamaBase) : Promise.resolve(null),
    ]);

    return {
      at: Date.now(),
      cpu: { usage, cores: cpus().length },
      memory,
      gpu,
      ollama,
      load: process.platform === 'win32' ? null : loadavg().map((value) => value),
    };
  }

  start(intervalMs: number, onSample: (snapshot: ResourceSnapshot) => void): void {
    this.stop();
    const tick = async (): Promise<void> => {
      if (this.inFlight) return;
      this.inFlight = true;
      try {
        onSample(await this.sample());
      } catch {
        // Resource sampling must never break the UI.
      } finally {
        this.inFlight = false;
      }
    };

    void tick();
    this.timer = setInterval(() => void tick(), Math.max(250, intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}G`;
  return `${Math.round(bytes / (1024 * 1024))}M`;
}

function percent(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}%`;
}

/** Short segments for the TUI status bar; the UI drops the ones that do not fit. */
export function vitalsSegments(snapshot: ResourceSnapshot): string[] {
  const segments = [
    `CPU ${percent(snapshot.cpu.usage)}`,
    `RAM ${formatBytesShort(snapshot.memory.used)}/${formatBytesShort(snapshot.memory.total)}`,
  ];

  const gpu = snapshot.gpu?.[0];
  if (gpu) {
    segments.push(
      `GPU ${percent(gpu.utilization)} ${formatBytesShort(gpu.memoryUsed)}/${formatBytesShort(gpu.memoryTotal)}`,
    );
  }

  const loaded = snapshot.ollama?.find((model) => model.sizeVram > 0);
  if (loaded) {
    segments.push(`VRAM ${formatBytesShort(loaded.sizeVram)}`);
  }

  return segments;
}

/** Multi-line report used by `/resources`. */
export function formatResourceReport(snapshot: ResourceSnapshot): string[] {
  const lines: string[] = [];

  const cpuLoad = snapshot.load ? ` · load ${snapshot.load.map((v) => v.toFixed(2)).join(' ')}` : '';
  lines.push(`CPU      ${percent(snapshot.cpu.usage)} of ${snapshot.cpu.cores} cores${cpuLoad}`);

  const memPercent = snapshot.memory.total > 0
    ? Math.round((snapshot.memory.used / snapshot.memory.total) * 100)
    : 0;
  lines.push(
    `Memory   ${formatBytesShort(snapshot.memory.used)} / ${formatBytesShort(
      snapshot.memory.total,
    )} (${memPercent}%)`,
  );

  if (snapshot.gpu === null) {
    lines.push('GPU      not detected (nvidia-smi unavailable)');
  } else if (snapshot.gpu.length === 0) {
    lines.push('GPU      no device reported');
  } else {
    for (const gpu of snapshot.gpu) {
      lines.push(
        `GPU ${gpu.index}    ${gpu.name} · ${percent(gpu.utilization)} · ${formatBytesShort(
          gpu.memoryUsed,
        )} / ${formatBytesShort(gpu.memoryTotal)} VRAM`,
      );
    }
  }

  if (snapshot.ollama === null) {
    lines.push('Ollama   not reachable');
  } else if (snapshot.ollama.length === 0) {
    lines.push('Ollama   no model loaded');
  } else {
    for (const model of snapshot.ollama) {
      const details = [model.parameterSize, model.quantization].filter(Boolean).join(' ');
      lines.push(
        `Ollama   ${model.name}${details ? ` (${details})` : ''} · ${formatBytesShort(
          model.sizeVram,
        )} VRAM of ${formatBytesShort(model.size)}`,
      );
    }
  }

  return lines;
}
