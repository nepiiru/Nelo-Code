import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamRenderer } from '../src/ui/render.js';

class MemoryStream {
  output = '';
  isTTY = false;

  write(chunk: string | Uint8Array): boolean {
    this.output += chunk.toString();
    return true;
  }
}

describe('StreamRenderer', () => {
  let previousNoColor: string | undefined;

  beforeEach(() => {
    previousNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
  });

  afterEach(() => {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  });

  it('streams complete lines and flushes the trailing partial line', () => {
    const stream = new MemoryStream();
    const renderer = new StreamRenderer(stream as unknown as NodeJS.WriteStream);

    renderer.push('first\nsec');
    expect(stream.output).toBe('first\n');

    renderer.push('ond\n');
    expect(stream.output).toBe('first\nsecond\n');

    renderer.push('tail');
    expect(stream.output).toBe('first\nsecond\n');
    renderer.flush();
    expect(stream.output).toBe('first\nsecond\ntail\n');
    renderer.flush();
    expect(stream.output).toBe('first\nsecond\ntail\n');
  });

  it('keeps markdown structure visible', () => {
    const stream = new MemoryStream();
    const renderer = new StreamRenderer(stream as unknown as NodeJS.WriteStream);

    renderer.push('## Heading\n- item\n```ts\nconst a = 1;\n```\n');
    renderer.flush();

    expect(stream.output).toContain('## Heading');
    expect(stream.output).toContain('- item');
    expect(stream.output).toContain('const a = 1;');
  });
});
