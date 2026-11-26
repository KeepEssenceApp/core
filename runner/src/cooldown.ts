// A site that refuses the runner's download is not asked again for a while. When a media download answers 567 (Bilibili's
// word for "not you, not now"), 412 or 429, every video of that site is told as "unavailable" at once for the cool-down
// (six hours unless the settings say otherwise): nothing is probed and nothing is downloaded, so the runner does not keep
// knocking on a door that has been shut, which keeps it shut longer.
//
// In memory, by site name only (never an address, never an account). A runner that restarts forgets it: the first video
// afterwards asks again, is refused again, and the cool-down starts again.

/** The statuses of a site refusing this client's download: Bilibili's 567 and 412, and "too many requests". */
export const COOLDOWN_STATUSES: ReadonlySet<number> = new Set([567, 412, 429]);

export interface Cooldown {
  /** Milliseconds left of this site's cool-down, or null when it is not cooling down. */
  active(site: string): number | null;
  start(site: string): void;
}

const MOST_SITES = 100;

/** `ms` of 0 (or less) is no cool-down at all. */
export function createCooldown(ms: number, now: () => number = Date.now): Cooldown {
  const until = new Map<string, number>();
  return {
    active(site) {
      const end = until.get(site);
      if (end === undefined) return null;
      const left = end - now();
      if (left <= 0) {
        until.delete(site);
        return null;
      }
      return left;
    },
    start(site) {
      if (!(ms > 0)) return;
      if (until.size >= MOST_SITES) for (const [name, end] of until) if (end <= now()) until.delete(name);
      if (until.size < MOST_SITES || until.has(site)) until.set(site, now() + ms);
    },
  };
}
