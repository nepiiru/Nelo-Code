export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string.`);
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string.`);
  return value;
}

export function optionalInteger(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`"${name}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`"${name}" must be true or false.`);
  return value;
}

export function optionalEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`"${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}
