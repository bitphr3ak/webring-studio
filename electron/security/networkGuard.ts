import * as dns from 'dns';
import * as net from 'net';

/**
 * SSRF guard for crawling peer sites. A friend's site (or a hub file) decides which URLs Studio
 * fetches, so without this a peer could point Studio at the user's router, local services, or
 * cloud metadata endpoints. Addresses are checked at connection time (via a custom DNS lookup),
 * which also covers redirects and DNS rebinding: the address that is checked is the one used.
 *
 * Set `WEBRING_ALLOW_PRIVATE_PEERS=1` to crawl peers on localhost or the LAN during development.
 */
const blockedRanges = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) {
  blockedRanges.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blockedRanges.addSubnet(network, prefix, 'ipv6');
}

export class PrivateNetworkAddressError extends Error {
  constructor(hostname: string, address: string) {
    super(
      `Refusing to fetch ${hostname}: it resolves to a private or local network address (${address}). Peer sites must be on the public internet.`
    );
    this.name = 'PrivateNetworkAddressError';
  }
}

export function privatePeersAllowed(): boolean {
  return process.env.WEBRING_ALLOW_PRIVATE_PEERS === '1';
}

export function isPrivateNetworkAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return blockedRanges.check(address, 'ipv4');
  }
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) is checked as the IPv4 address it wraps
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) {
      return blockedRanges.check(mapped[1], 'ipv4');
    }
    return blockedRanges.check(address, 'ipv6');
  }
  return true; // Not an IP address at all: refuse rather than guess
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;

/**
 * Drop-in `lookup` for `http.request` that refuses hostnames resolving to private addresses.
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    if (!privatePeersAllowed()) {
      const blocked = addresses.find((a) => isPrivateNetworkAddress(a.address));
      if (blocked) {
        callback(new PrivateNetworkAddressError(hostname, blocked.address), '');
        return;
      }
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
}
