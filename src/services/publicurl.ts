// Which addresses may be fetched: public http/https only. Pure functions, shared by the Worker's
// direct read and by the runner (which also checks the address a name resolves to, at connect time).

function ipv4Private(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** An IPv6 address (no brackets) that is not a public unicast one: loopback, unspecified, unique-local, link-local, multicast, mapped IPv4, translation. */
function ipv6Private(v6: string): boolean {
  const a = v6.toLowerCase();
  return a === "::1" || a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("::ffff:") || a.startsWith("64:ff9b:");
}

/** True when the address may be fetched: public http/https only. */
export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return false;
  // An IPv6 literal: refuse loopback, unspecified, unique-local, link-local, multicast, and mapped IPv4.
  if (host.startsWith("[")) return !ipv6Private(host.slice(1, -1));
  if (ipv4Private(host)) return false;
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return false;
  if (host === "localhost" || !host.includes(".")) return false;
  if (/\.(localhost|local|internal|lan|home|corp|intranet|onion)$/.test(host)) return false;
  return true;
}

/**
 * True when an address a name resolved to (an IPv4 or IPv6 literal, no brackets) is public. The
 * runner asks this at connect time, for the address it is about to connect to, so a name that
 * points into the machine's own network (or changes its answer between two lookups) is refused.
 */
export function isPublicIp(ip: string): boolean {
  if (ip.includes(":")) return !ipv6Private(ip);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ipv4Private(ip);
}
