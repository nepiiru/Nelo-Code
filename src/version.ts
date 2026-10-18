import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function getVersion(): string {
  if (cached !== null) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
