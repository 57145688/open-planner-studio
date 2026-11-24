const DAY_MS = 86_400_000;

export function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build a list of working-day ISO dates starting at (or after) startIso.
 * Simplified calendar: full working days only, no holidays.
 */
export function buildWorkingCalendar(
  startIso: string,
  workweek: number[],
  length: number,
): string[] {
  const dates: string[] = [];
  let cursor = parseIsoDate(startIso);
  const target = Math.max(length, 1);
  let guard = 0;
  while (!workweek.includes(cursor.getUTCDay())) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (++guard > 14) break;
  }
  while (dates.length < target) {
    if (workweek.includes(cursor.getUTCDay())) dates.push(toIsoDate(cursor));
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return dates;
}

/** Index of the last working day that is <= iso. Returns -1 when before start. */
export function workingIndexFor(calendar: string[], iso: string): number {
  let lo = 0;
  let hi = calendar.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (calendar[mid] <= iso) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
