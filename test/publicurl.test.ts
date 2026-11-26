// QA #101: the address checks the runner shares with the Worker (src/services/publicurl.ts).
import { describe, expect, it } from "vitest";
import { isPublicIp, isPublicUrl } from "../src/services/publicurl";

describe("public addresses", () => {
  it("an address a name resolved to is public only when it is public unicast", () => {
    for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "64:ff9b::1", "not an address", ""]) {
      expect(`${bad} ${isPublicIp(bad)}`).toBe(`${bad} false`);
    }
    for (const good of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) expect(`${good} ${isPublicIp(good)}`).toBe(`${good} true`);
  });

  it("the address checks of the direct read are unchanged, and multicast IPv6 literals are refused too", () => {
    expect(isPublicUrl("https://example.org/a")).toBe(true);
    expect(isPublicUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/")).toBe(true);
    for (const bad of ["http://127.0.0.1/", "http://[::1]/", "http://[ff02::1]/", "http://[::ffff:10.0.0.1]/", "http://localhost/", "http://db.internal/", "ftp://example.org/", "http://user:pw@example.org/", "http://2130706433/"]) {
      expect(`${bad} ${isPublicUrl(bad)}`).toBe(`${bad} false`);
    }
  });
});
