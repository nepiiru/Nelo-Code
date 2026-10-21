import { describe, expect, it } from 'vitest';
import {
  formatBytesShort,
  formatResourceReport,
  vitalsSegments,
  type ResourceSnapshot,
} from '../src/system/resources.js';

function snapshot(patch: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    at: Date.now(),
    cpu: { usage: 12.4, cores: 8 },
    memory: { used: 9.5 * 1024 ** 3, total: 32 * 1024 ** 3 },
    gpu: null,
    ollama: null,
    load: null,
    ...patch,
  };
}

describe('formatBytesShort', () => {
  it('formats gigabytes and megabytes', () => {
    expect(formatBytesShort(9.5 * 1024 ** 3)).toBe('9.5G');
    expect(formatBytesShort(512 * 1024 ** 2)).toBe('512M');
    expect(formatBytesShort(0)).toBe('0');
  });
});

describe('vitalsSegments', () => {
  it('always reports CPU and RAM', () => {
    const segments = vitalsSegments(snapshot());
    expect(segments[0]).toBe('CPU 12%');
    expect(segments[1]).toBe('RAM 9.5G/32.0G');
    expect(segments).toHaveLength(2);
  });

  it('adds GPU and VRAM when available', () => {
    const segments = vitalsSegments(
      snapshot({
        gpu: [
          {
            index: 0,
            name: 'Test GPU',
            utilization: 71,
            memoryUsed: 4 * 1024 ** 3,
            memoryTotal: 12 * 1024 ** 3,
          },
        ],
        ollama: [{ name: 'qwen:7b', size: 5 * 1024 ** 3, sizeVram: 4.8 * 1024 ** 3 }],
      }),
    );

    expect(segments).toContain('GPU 71% 4.0G/12.0G');
    expect(segments).toContain('VRAM 4.8G');
  });

  it('shows "--" when the CPU delta is not ready yet', () => {
    const segments = vitalsSegments(snapshot({ cpu: { usage: null, cores: 8 } }));
    expect(segments[0]).toBe('CPU --');
  });
});

describe('formatResourceReport', () => {
  it('describes every subsystem', () => {
    const report = formatResourceReport(
      snapshot({
        gpu: [
          {
            index: 0,
            name: 'RTX Test',
            utilization: 43,
            memoryUsed: 2 * 1024 ** 3,
            memoryTotal: 8 * 1024 ** 3,
          },
        ],
        ollama: [
          {
            name: 'qwen:7b',
            size: 5 * 1024 ** 3,
            sizeVram: 4 * 1024 ** 3,
            parameterSize: '7B',
            quantization: 'Q4_K_M',
          },
        ],
      }),
    ).join('\n');

    expect(report).toContain('CPU      12% of 8 cores');
    expect(report).toContain('Memory   9.5G / 32.0G (30%)');
    expect(report).toContain('GPU 0    RTX Test · 43%');
    expect(report).toContain('Ollama   qwen:7b (7B Q4_K_M)');
  });

  it('explains missing GPU and Ollama support', () => {
    const report = formatResourceReport(snapshot()).join('\n');
    expect(report).toContain('GPU      not detected');
    expect(report).toContain('Ollama   not reachable');
  });

  it('reports an idle Ollama', () => {
    const report = formatResourceReport(snapshot({ ollama: [] })).join('\n');
    expect(report).toContain('Ollama   no model loaded');
  });
});
