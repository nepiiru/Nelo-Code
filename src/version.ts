import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function getVersion(): string {
  if (cached !== null) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    // package.json may carry a UTF-8 BOM depending on the editor/tooling that wrote it.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { version?: unknown };
    cached = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
