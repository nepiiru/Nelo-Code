import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli-args.js';

describe('parseArgs', () => {
  it('parses a bare prompt', () => {
    const args = parseArgs(['explain this repo']);
    expect(args.prompt).toBe('explain this repo');
    expect(args.print).toBe(false);
  });

  it('joins multiple positional words', () => {
    expect(parseArgs(['fix', 'the', 'tests']).prompt).toBe('fix the tests');
  });

  it('parses flags in any order', () => {
    const args = parseArgs(['-y', '--model', 'opus', '-p', 'hello']);
    expect(args.mode).toBe('auto');
    expect(args.model).toBe('opus');
    expect(args.print).toBe(true);
    expect(args.prompt).toBe('hello');
  });

  it('supports --flag=value syntax', () => {
    const args = parseArgs(['--model=haiku', '--max-tokens=4096', '--mode=readonly']);
    expect(args.model).toBe('haiku');
    expect(args.maxTokens).toBe(4096);
    expect(args.mode).toBe('readonly');
  });

  it('parses continue and resume', () => {
    expect(parseArgs(['-c']).continueSession).toBe(true);
    expect(parseArgs(['--resume', 'abc']).resumeId).toBe('abc');
    expect(parseArgs(['--resume=abc']).resumeId).toBe('abc');
  });

  it('parses --no-tui', () => {
    expect(parseArgs([]).noTui).toBe(false);
    expect(parseArgs(['--no-tui']).noTui).toBe(true);
  });

  it('detects the config subcommand', () => {
    const args = parseArgs(['config']);
    expect(args.command).toBe('config');
    expect(args.prompt).toBeUndefined();
  });

  it('treats text after -- as a prompt', () => {
    expect(parseArgs(['--', '--not-a-flag']).prompt).toBe('--not-a-flag');
  });

  it('rejects unknown options', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
  });

  it('rejects invalid values', () => {
    expect(() => parseArgs(['--mode', 'yolo'])).toThrow(/--mode/);
    expect(() => parseArgs(['--max-tokens', 'abc'])).toThrow(/--max-tokens/);
    expect(() => parseArgs(['--model'])).toThrow(/Missing value/);
  });
});
