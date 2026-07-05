import dns from 'dns'
import net from 'net'
import { Agent, fetch as undiciFetch } from 'undici'

export function normalizeUrl(url) {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function assertPrivateIpv4(hostname) {
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4Match) return
  const [, a, b] = ipv4Match.map(Number)
  if (a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && b >= 18 && b <= 19) ||
      (a >= 224 && a <= 239) ||
      (a >= 240)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }
}

// Detect IPv4-mapped IPv6 (::ffff:/96) in BOTH dotted and hex forms and
// return the embedded IPv4 as a dotted-quad string, or null when the input
// is not an IPv4-mapped address. WHATWG URL canonicalises `[::ffff:127.0.0.1]`
// to `[::ffff:7f00:1]`, so the hex form must be handled or assertPublicUrl /
// _validateIpv6 will miss mapped loopback / private addresses.
function _mappedIpv4FromIpv6(bare) {
  const lower = bare.toLowerCase()
  // Dotted form: ::ffff:a.b.c.d
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return dotted[1]
  // Hex form: ::ffff:HHHH:LLLL — low 32 bits of the /96 prefix carry the IPv4.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    if (Number.isFinite(high) && Number.isFinite(low) && high <= 0xffff && low <= 0xffff) {
      const a = (high >> 8) & 0xff
      const b = high & 0xff
      const c = (low >> 8) & 0xff
      const d = low & 0xff
      return `${a}.${b}.${c}.${d}`
    }
  }
  return null
}

export function assertPublicUrl(url) {
  const parsed = new URL(url)

  // Block dangerous protocols
  const blockedProtocols = ['file:', 'ftp:', 'data:', 'javascript:']
  if (blockedProtocols.includes(parsed.protocol)) {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname.toLowerCase()

  // Reject userinfo (user:pass@host) — credential-injection / SSRF vector
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked URL with userinfo credentials: ${hostname}`)
  }

  // Localhost
  if (hostname === 'localhost') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv4 private/reserved ranges
  assertPrivateIpv4(hostname)

  // Strip brackets for IPv6 analysis (URL parser stores IPv6 without brackets in .hostname)
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname

  // IPv6 loopback
  if (bare === '::1') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv6 unspecified (::)
  if (bare === '::') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv6 multicast (ff00::/8)
  if (/^ff/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv4-mapped IPv6 — ::ffff:a.b.c.d
  // Cover both dotted (::ffff:127.0.0.1) and hex (::ffff:7f00:1) forms —
  // WHATWG URL canonicalises bracketed mapped literals to the hex shape.
  const mappedIpv4 = _mappedIpv4FromIpv6(bare)
  if (mappedIpv4) {
    assertPrivateIpv4(mappedIpv4)
  }

  // IPv6 private (fc00::/7 — starts with fc or fd)
  if (/^f[cd]/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv6 link-local (fe80::/10 — starts with fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }
}

function _validateIpv6(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1') {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (lower === '::') {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (/^ff/i.test(lower)) {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (/^f[cd]/i.test(lower)) {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (/^fe[89ab]/i.test(lower)) {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  // Cover both dotted and hex IPv4-mapped IPv6 forms — resolver output and
  // WHATWG-canonicalised URL hostnames may arrive as `::ffff:7f00:1`.
  const mappedIpv4 = _mappedIpv4FromIpv6(lower)
  if (mappedIpv4) {
    assertPrivateIpv4(mappedIpv4)
  }
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
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason || new Error(`${label} aborted`))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error(`${label} aborted`))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

export async function resolveAndValidate(hostname, { signal } = {}) {
  // Literal IPs bypass DNS entirely — validate directly.
  if (net.isIP(hostname)) {
    if (net.isIPv4(hostname)) {
      assertPrivateIpv4(hostname)
      return [{ address: hostname, family: 4 }]
    }
    _validateIpv6(hostname)
    return [{ address: hostname, family: 6 }]
  }

  const addresses = []
  const seen = new Set()
  const push = (address, family) => {
    const key = `${family}:${address}`
    if (seen.has(key)) return
    seen.add(key)
    addresses.push({ address, family })
  }

  // dns.lookup mirrors what the platform resolver will hand to the connector;
  // resolve4/resolve6 catch entries the stub resolver returns even when the
  // OS lookup table would omit them.
  let lookupAddrs = []
  try {
    lookupAddrs = await _abortRace(dns.promises.lookup(hostname, { all: true }), signal, 'dns.lookup')
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const entry of lookupAddrs) {
    if (entry.family === 4) assertPrivateIpv4(entry.address)
    else _validateIpv6(entry.address)
    push(entry.address, entry.family)
  }

  let v4Addrs = []
  try {
    v4Addrs = await _abortRace(dns.promises.resolve4(hostname), signal, 'dns.resolve4')
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const ip of v4Addrs) {
    assertPrivateIpv4(ip)
    push(ip, 4)
  }

  let v6Addrs = []
  try {
    v6Addrs = await _abortRace(dns.promises.resolve6(hostname), signal, 'dns.resolve6')
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const ip of v6Addrs) {
    _validateIpv6(ip)
    push(ip, 6)
  }

  return addresses
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
  const bare = _bareHost(hostname)
  const addresses = await resolveAndValidate(bare)
  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${hostname}`)
  }
}

// Bare hostname helper that strips IPv6 brackets — undici / WHATWG URL stores
// IPv6 hostnames with the brackets included.
function _bareHost(hostname) {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
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
  const parsed = new URL(url)
  const host = _bareHost(parsed.hostname)
  // Bound the validating DNS lookups by the request's own abort signal so a
  // hung resolver cannot outlive the fetch timeout.
  const addresses = await resolveAndValidate(host, { signal: options.signal })
  if (addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${host}`)
  }
  // Deterministic: pin to the first validated address. Every entry in
  // `addresses` already passed assertPrivateIpv4 / IPv6 checks, so picking any
  // index is safe — first-match keeps behaviour stable across calls.
  const pinned = addresses[0]
  const dispatcher = new Agent({
    connect: {
      // Custom lookup invoked by undici's connector. We ignore the requested
      // hostname argument and unconditionally hand back the pre-validated IP,
      // so DNS rebinding cannot flip the address between assert and connect.
      lookup: (_hostname, opts, cb) => {
        if (opts && opts.all) {
          cb(null, [{ address: pinned.address, family: pinned.family }])
        } else {
          cb(null, pinned.address, pinned.family)
        }
      },
    },
  })
  // The per-request Agent owns a dedicated connection pool. If it is never
  // closed it leaks the kept-alive socket until GC. Destroy it once the body
  // is fully consumed, cancelled, or the request errors — wrapping the body
  // stream so the dispatcher outlives streaming reads but is always reclaimed.
  let response
  try {
    response = await undiciFetch(url, { ...options, dispatcher })
  } catch (err) {
    dispatcher.destroy().catch(() => {})
    throw err
  }
  let cleaned = false
  const cleanup = () => { if (!cleaned) { cleaned = true; dispatcher.destroy().catch(() => {}) } }
  // If there's no body to stream, the response is already complete.
  if (!response.body) {
    cleanup()
    return response
  }
  // Wrap the body in a ReadableStream that pulls from the original reader and
  // destroys the dispatcher when the stream ends, errors, or the consumer
  // cancels it. ReadableStream's underlying-source pull/cancel callbacks are
  // reliably invoked, so the per-request Agent is always reclaimed instead of
  // leaking its kept-alive socket until GC.
  const reader = response.body.getReader()
  const monitored = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          cleanup()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        controller.error(err)
        cleanup()
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
      cleanup()
    },
  })
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
