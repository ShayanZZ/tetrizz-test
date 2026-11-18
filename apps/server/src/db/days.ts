/** UTC day helpers. A day is `YYYY-MM-DD`; its start is midnight UTC. */

export const DAY_MS = 86_400_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  const start = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(start) && dayOf(start) === value;
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStart(day: string): number {
  if (!isDay(day)) throw new RangeError(`not a day: ${day}`);
  return Date.parse(`${day}T00:00:00Z`);
}
