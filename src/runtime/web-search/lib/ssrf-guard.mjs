import dns from 'node:dns';
import net from 'node:net';

// Shared URL guard for the web-search runtime and bounded fetch consumers.
export function normalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.toString();
}

function assertPrivateIpv4(hostname) {
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return;
  const [, a, b, c] = ipv4Match.map(Number);
  if (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && b >= 18 && b <= 19) ||
    // IANA special-purpose blocks that are not globally reachable: IETF
    // protocol assignments, documentation (TEST-NET-1/2/3) and the retired
    // 6to4 relay anycast prefix.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a >= 224 && a <= 239) ||
    a >= 240
  ) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }
}

// Detect IPv4-mapped IPv6 (::ffff:/96) in BOTH dotted and hex forms and
// return the embedded IPv4 as a dotted-quad string, or null when the input
// is not an IPv4-mapped address. WHATWG URL canonicalises `[::ffff:127.0.0.1]`
// to `[::ffff:7f00:1]`, so the hex form must be handled or assertPublicUrl /
// _validateIpv6 will miss mapped loopback / private addresses.
function _mappedIpv4FromIpv6(bare) {
  const lower = bare.toLowerCase();
  // Dotted form: ::ffff:a.b.c.d
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  // Hex form: ::ffff:HHHH:LLLL — low 32 bits of the /96 prefix carry the IPv4.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    if (Number.isFinite(high) && Number.isFinite(low) && high <= 0xffff && low <= 0xffff) {
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const c = (low >> 8) & 0xff;
      const d = low & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
  }
  return null;
}

export function assertPublicUrl(url) {
  const parsed = new URL(url);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Reject userinfo (user:pass@host) — credential-injection / SSRF vector
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked URL with userinfo credentials: ${hostname}`);
  }

  // Localhost
  if (hostname === 'localhost') {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }

  // IPv4 private/reserved ranges
  assertPrivateIpv4(hostname);

  // Strip the brackets that WHATWG URL retains around IPv6 hostnames, then
  // apply the same IPv6 rules the resolver path uses; the original hostname
  // stays the reported one. The rules are ADDRESS rules, so they run only on
  // an actual IPv6 literal: a DNS name is not an address, and prefix-matching
  // it blocked ordinary public domains (ffmpeg.org, fdroid.org) on their
  // leading hex-looking letters. A name's real addresses are validated where
  // they are learned — resolveAndValidate/_validateIpv6 on every A/AAAA record.
  const bare = _bareHost(hostname);
  if (net.isIPv6(bare)) _validateIpv6(bare, hostname);
}

/** The IPv6 block rules, shared by URL validation and resolver output.
 *  `label` is what a rejection reports, so a bracketed URL hostname keeps its
 *  original form. */
function _validateIpv6(ip, label = ip) {
  const lower = ip.toLowerCase();
  // Loopback (::1), unspecified (::), multicast (ff00::/8), unique-local
  // (fc00::/7) and link-local (fe80::/10).
  if (lower === '::1' || lower === '::' || /^(?:ff|f[cd]|fe[89ab])/i.test(lower)) {
    throw new Error(`Blocked request to private address: ${label}`);
  }
  // Cover both dotted (::ffff:127.0.0.1) and hex (::ffff:7f00:1) IPv4-mapped
  // forms — resolver output and WHATWG-canonicalised URL hostnames use either.
  const mappedIpv4 = _mappedIpv4FromIpv6(lower);
  if (mappedIpv4) {
    assertPrivateIpv4(mappedIpv4);
  }
  const h = _ipv6Hextets(lower);
  // Site-local (fec0::/10), documentation (2001:db8::/32, 3fff::/20),
  // discard-only (100::/64) and local-use NAT64 (64:ff9b:1::/48) never name a
  // public host.
  if (
    (h[0] & 0xffc0) === 0xfec0 ||
    (h[0] === 0x2001 && h[1] === 0x0db8) ||
    (h[0] === 0x3fff && h[1] < 0x1000) ||
    (h[0] === 0x0100 && !h[1] && !h[2] && !h[3]) ||
    (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1)
  ) {
    throw new Error(`Blocked request to private address: ${label}`);
  }
  // Addresses that carry an IPv4 destination: IPv4-compatible ::a.b.c.d,
  // NAT64 64:ff9b::/96 and 6to4 2002:AABB:CCDD::/48 reach that IPv4, so it
  // gets the IPv4 rules.
  const quad = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (h.slice(0, 6).every((part) => part === 0)) assertPrivateIpv4(quad(h[6], h[7]));
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((part) => part === 0)) {
    assertPrivateIpv4(quad(h[6], h[7]));
  }
  if (h[0] === 0x2002) assertPrivateIpv4(quad(h[1], h[2]));
}

/** The eight 16-bit groups of a valid IPv6 literal (zone id dropped, a
 *  trailing dotted IPv4 folded into the last two groups). */
function _ipv6Hextets(ip) {
  let text = ip.split('%')[0];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - front.length - back.length).fill('0');
  return [...front, ...fill, ...back].map((part) => Number.parseInt(part, 16) || 0);
}

// Resolve hostname once, validate EVERY returned address (so a DNS round-robin
// can't smuggle a private IP behind a public one), and return the de-duped
// `{address, family}` list. The caller pins the real connection to one of
// these addresses so a second uncontrolled resolution (DNS rebinding / TOCTOU)
// cannot flip the IP between validation and connect.
// Race a DNS promise against an abort signal so a hung resolver cannot
// outlive the request's timeout budget. The signal is the same one that
// bounds the outbound fetch (AbortSignal.timeout / requestTimeoutMs), so
// DNS is bounded by the same deadline as the connection.
function _abortRace(promise, signal, label) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error(`${label} aborted`));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error(`${label} aborted`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

export async function resolveAndValidate(hostname, { signal } = {}) {
  // Literal IPs bypass DNS entirely — validate directly.
  if (net.isIP(hostname)) {
    if (net.isIPv4(hostname)) {
      assertPrivateIpv4(hostname);
      return [{ address: hostname, family: 4 }];
    }
    _validateIpv6(hostname);
    return [{ address: hostname, family: 6 }];
  }

  const addresses = [];
  const seen = new Set();
  const push = (address, family) => {
    const key = `${family}:${address}`;
    if (seen.has(key)) return;
    seen.add(key);
    addresses.push({ address, family });
  };

  // dns.lookup mirrors what the platform resolver will hand to the connector;
  // resolve4/resolve6 catch entries the stub resolver returns even when the
  // OS lookup table would omit them.
  let lookupAddrs = [];
  try {
    lookupAddrs = await _abortRace(dns.promises.lookup(hostname, { all: true }), signal, 'dns.lookup');
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err;
  }
  for (const entry of lookupAddrs) {
    if (entry.family === 4) assertPrivateIpv4(entry.address);
    else _validateIpv6(entry.address);
    push(entry.address, entry.family);
  }

  let v4Addrs = [];
  try {
    v4Addrs = await _abortRace(dns.promises.resolve4(hostname), signal, 'dns.resolve4');
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err;
  }
  for (const ip of v4Addrs) {
    assertPrivateIpv4(ip);
    push(ip, 4);
  }

  let v6Addrs = [];
  try {
    v6Addrs = await _abortRace(dns.promises.resolve6(hostname), signal, 'dns.resolve6');
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err;
  }
  for (const ip of v6Addrs) {
    _validateIpv6(ip);
    push(ip, 6);
  }

  return addresses;
}

export async function assertResolvedIps(hostname) {
  // Backward-compatible wrapper: callers that only need validation (e.g. the
  // Puppeteer request interceptor, which cannot pin Chromium's connect) still
  // get the same throw-on-private behaviour.
  // Fail closed: an empty result (no DNS records, all lookups returned
  // ENODATA/ENOTFOUND) must NOT be treated as success — the Puppeteer path
  // would otherwise hand the raw hostname to Chromium for a second,
  // unvalidated resolution.
  // Callers pass `new URL(...).hostname`, which on Node/Bun keeps the
  // brackets around IPv6 literals (e.g. `[2606:4700::1111]`). Strip them
  // here so resolveAndValidate's net.isIP() path recognises the literal
  // instead of falling through to a doomed DNS lookup on `[..]`.
  const bare = _bareHost(hostname);
  const addresses = await resolveAndValidate(bare);
  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${hostname}`);
  }
}

// Bare hostname helper that strips IPv6 brackets — undici / WHATWG URL stores
// IPv6 hostnames with the brackets included.
function _bareHost(hostname) {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

// SSRF-hardened fetch: resolves the host ONCE, validates every returned
// address, then connects to a single pre-validated IP via a per-request
// undici Agent whose `connect.lookup` returns that IP only. This closes the
// validate-then-fetch TOCTOU / DNS-rebinding window because the connector
// never performs a second resolution against the live DNS — the Host header
// (undici fills from the URL) and TLS SNI (likewise) are unaffected, so
// virtual hosts and HTTPS certificate validation keep working against
// legitimate public sites.
export async function pinnedFetch(url, options = {}) {
  const parsed = new URL(url);
  const host = _bareHost(parsed.hostname);
  // Bound the validating DNS lookups by the request's own abort signal so a
  // hung resolver cannot outlive the fetch timeout.
  const addresses = await resolveAndValidate(host, { signal: options.signal });
  if (addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${host}`);
  }
  // All returned addresses are validated. Let the connector try both IP
  // families instead of failing a usable site on an unreachable first address.
  const pinned = addresses[0];
  // undici is ~100 modules; the hook bus imports this file at runtime boot,
  // so load it on the first pinned request instead of on every launch.
  const { Agent, fetch: undiciFetch } = await import('undici');
  const dispatcher = new Agent({
    connect: {
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      // Custom lookup invoked by undici's connector. We ignore the requested
      // hostname argument and unconditionally hand back the pre-validated IP,
      // so DNS rebinding cannot flip the address between assert and connect.
      lookup: (_hostname, opts, cb) => {
        if (opts?.all) {
          cb(
            null,
            addresses.map(({ address, family }) => ({ address, family }))
          );
        } else {
          cb(null, pinned.address, pinned.family);
        }
      },
    },
  });
  // The per-request Agent owns a dedicated connection pool. If it is never
  // closed it leaks the kept-alive socket until GC. Destroy it once the body
  // is fully consumed, cancelled, or the request errors — wrapping the body
  // stream so the dispatcher outlives streaming reads but is always reclaimed.
  let response;
  try {
    response = await undiciFetch(url, { ...options, dispatcher });
  } catch (err) {
    dispatcher.destroy().catch(() => {});
    throw err;
  }
  let cleaned = false;
  const cleanup = () => {
    if (!cleaned) {
      cleaned = true;
      dispatcher.destroy().catch(() => {});
    }
  };
  // If there's no body to stream, the response is already complete.
  if (!response.body) {
    cleanup();
    return response;
  }
  // Wrap the body in a ReadableStream that pulls from the original reader and
  // destroys the dispatcher when the stream ends, errors, or the consumer
  // cancels it. ReadableStream's underlying-source pull/cancel callbacks are
  // reliably invoked, so the per-request Agent is always reclaimed instead of
  // leaking its kept-alive socket until GC.
  const reader = response.body.getReader();
  const monitored = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          cleanup();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        cleanup();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      cleanup();
    },
  });
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
