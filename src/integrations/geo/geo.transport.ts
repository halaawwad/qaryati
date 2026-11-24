import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';
import { GeoError } from './geo.errors.js';
import { safeGeoEndpoint } from './geo.config.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6'); // Teredo can encapsulate non-public IPv4.
blocked.addSubnet('2002::', 16, 'ipv6'); // 6to4 embeds an IPv4 destination.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicGeoAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') :
    family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

// Validate the exact DNS answers used by the socket, rather than resolving once and
// letting fetch resolve again (DNS rebinding). No redirects or IP literals are allowed.
const dispatcher = new Agent({ connect: {
  lookup(hostname, options, callback) {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) { callback(error, '', 4); return; }
      if (!addresses.length || addresses.some(item => !publicGeoAddress(item.address))) {
        callback(new Error('Unsafe geo provider DNS response'), '', 4); return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  },
} });

export const secureGeoFetch: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  const endpoint = new URL(url); endpoint.search = '';
  if (!safeGeoEndpoint(endpoint.href)) throw new GeoError('GEO_CONFIGURATION', 'Invalid geographic provider configuration');
  // Node's bundled undici-types can lag the installed dispatcher declarations.
  // The runtime Dispatcher interface is supported by native fetch.
  return fetch(input, { ...init, redirect: 'error', dispatcher } as unknown as RequestInit);
};
