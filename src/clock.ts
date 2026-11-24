// The only source of time in the core. Tests move it instead of sleeping.
let fixed: number | null = null;

export function now(): number {
  return fixed ?? Date.now();
}

/** Tests: freeze the clock at `ms`, or pass null to follow real time again. */
export function setNow(ms: number | null): void {
  fixed = ms;
}

/** Tests: move a frozen clock forward. */
export function advance(ms: number): void {
  fixed = (fixed ?? Date.now()) + ms;
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
