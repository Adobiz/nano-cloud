/** Parse bounded integers without passing Infinity/fractions to SQLite. */
export function integer(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, Math.floor(n)));
}
