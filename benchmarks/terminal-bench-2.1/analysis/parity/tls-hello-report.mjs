// What a server can observe in two ClientHellos and where they differ: Node's (tls-hello-capture.mjs) and the Rust core's
// (mixdog-ai tests/it/tls_hello.rs with MIXDOG_TLS_HELLO_OUT). Prints each hello's fields, then the differences.
// Usage: node tls-hello-report.mjs <node-hello.json> <rust-hello.json>
import { readFileSync } from 'node:fs';

const CIPHERS = { 0x1301: 'TLS_AES_128_GCM_SHA256', 0x1302: 'TLS_AES_256_GCM_SHA384', 0x1303: 'TLS_CHACHA20_POLY1305_SHA256', 0xc02b: 'ECDHE_ECDSA_AES128_GCM_SHA256', 0xc02f: 'ECDHE_RSA_AES128_GCM_SHA256', 0xc02c: 'ECDHE_ECDSA_AES256_GCM_SHA384', 0xc030: 'ECDHE_RSA_AES256_GCM_SHA384', 0xcca9: 'ECDHE_ECDSA_CHACHA20_POLY1305', 0xcca8: 'ECDHE_RSA_CHACHA20_POLY1305', 0xc009: 'ECDHE_ECDSA_AES128_SHA', 0xc013: 'ECDHE_RSA_AES128_SHA', 0xc00a: 'ECDHE_ECDSA_AES256_SHA', 0xc014: 'ECDHE_RSA_AES256_SHA', 0x009c: 'RSA_AES128_GCM_SHA256', 0x009d: 'RSA_AES256_GCM_SHA384', 0x002f: 'RSA_AES128_SHA', 0x0035: 'RSA_AES256_SHA', 0x00ff: 'EMPTY_RENEGOTIATION_INFO_SCSV', 0x009e: 'DHE_RSA_AES128_GCM_SHA256', 0x009f: 'DHE_RSA_AES256_GCM_SHA384', 0xccaa: 'DHE_RSA_CHACHA20_POLY1305', 0x0033: 'DHE_RSA_AES128_SHA', 0x0039: 'DHE_RSA_AES256_SHA', 0x003c: 'RSA_AES128_SHA256', 0x003d: 'RSA_AES256_SHA256', 0x0067: 'DHE_RSA_AES128_SHA256', 0x006b: 'DHE_RSA_AES256_SHA256', 0xc023: 'ECDHE_ECDSA_AES128_SHA256', 0xc027: 'ECDHE_RSA_AES128_SHA256', 0xc024: 'ECDHE_ECDSA_AES256_SHA384', 0xc028: 'ECDHE_RSA_AES256_SHA384' };
const EXTENSIONS = { 0: 'server_name', 5: 'status_request', 10: 'supported_groups', 11: 'ec_point_formats', 13: 'signature_algorithms', 16: 'alpn', 18: 'signed_certificate_timestamp', 21: 'padding', 22: 'encrypt_then_mac', 23: 'extended_master_secret', 27: 'compress_certificate', 35: 'session_ticket', 43: 'supported_versions', 45: 'psk_key_exchange_modes', 51: 'key_share', 65281: 'renegotiation_info', 41: 'pre_shared_key', 42: 'early_data', 49: 'post_handshake_auth', 50: 'signature_algorithms_cert', 17513: 'application_settings' };
const GROUPS = { 23: 'secp256r1', 24: 'secp384r1', 25: 'secp521r1', 29: 'x25519', 30: 'x448', 256: 'ffdhe2048', 257: 'ffdhe3072', 258: 'ffdhe4096', 259: 'ffdhe6144', 260: 'ffdhe8192', 4588: 'X25519MLKEM768', 4587: 'SecP256r1MLKEM768', 25497: 'X25519Kyber768Draft00' };
const SIGALGS = { 0x0401: 'rsa_pkcs1_sha256', 0x0501: 'rsa_pkcs1_sha384', 0x0601: 'rsa_pkcs1_sha512', 0x0403: 'ecdsa_secp256r1_sha256', 0x0503: 'ecdsa_secp384r1_sha384', 0x0603: 'ecdsa_secp521r1_sha512', 0x0804: 'rsa_pss_rsae_sha256', 0x0805: 'rsa_pss_rsae_sha384', 0x0806: 'rsa_pss_rsae_sha512', 0x0807: 'ed25519', 0x0808: 'ed448', 0x0809: 'rsa_pss_pss_sha256', 0x080a: 'rsa_pss_pss_sha384', 0x080b: 'rsa_pss_pss_sha512', 0x0201: 'rsa_pkcs1_sha1', 0x0203: 'ecdsa_sha1', 0x0402: 'dsa_sha256', 0x0303: 'ecdsa_sha224', 0x0301: 'rsa_sha224' };
const grease = (v) => (v & 0x0f0f) === 0x0a0a;
const name = (table, v) => (grease(v) ? 'GREASE' : table[v] ?? `0x${v.toString(16).padStart(4, '0')}`);

function parse(hex) {
  const b = Buffer.from(hex, 'hex');
  let p = 5 + 4; // record header, handshake header
  const hello = { recordVersion: b.readUInt16BE(1), clientVersion: b.readUInt16BE(p) };
  p += 2 + 32;
  const sid = b[p]; p += 1 + sid; hello.sessionIdLength = sid;
  const cs = b.readUInt16BE(p); p += 2;
  hello.ciphers = []; for (let i = 0; i < cs; i += 2) hello.ciphers.push(b.readUInt16BE(p + i)); p += cs;
  p += 1 + b[p]; // compression
  const end = p + 2 + b.readUInt16BE(p); p += 2;
  hello.extensions = [];
  while (p < end) { const type = b.readUInt16BE(p), len = b.readUInt16BE(p + 2); hello.extensions.push({ type, data: b.subarray(p + 4, p + 4 + len) }); p += 4 + len; }
  const ext = (t) => hello.extensions.find((e) => e.type === t)?.data;
  const list16 = (d, off = 2) => { const out = []; if (d) for (let i = off; i + 1 < d.length; i += 2) out.push(d.readUInt16BE(i)); return out; };
  hello.groups = list16(ext(10));
  hello.sigalgs = list16(ext(13));
  hello.ecPointFormats = ext(11) ? [...ext(11).subarray(1)] : [];
  hello.versions = ext(43) ? [...Array(ext(43)[0] / 2)].map((_, i) => ext(43).readUInt16BE(1 + 2 * i)) : [];
  hello.alpn = []; const a = ext(16); if (a) { let i = 2; while (i < a.length) { hello.alpn.push(a.subarray(i + 1, i + 1 + a[i]).toString()); i += 1 + a[i]; } }
  hello.keyShares = []; const k = ext(51); if (k) { let i = 2; while (i < k.length) { hello.keyShares.push(k.readUInt16BE(i)); i += 4 + k.readUInt16BE(i + 2); } }
  hello.pskModes = ext(45) ? [...ext(45).subarray(1)] : [];
  hello.sni = ext(0) ? ext(0).subarray(5).toString() : null;
  hello.ticketOffered = ext(35) !== undefined; hello.psk = ext(41) !== undefined;
  hello.length = b.length;
  return hello;
}

const show = (h) => ({
  'record/client version': `0x${h.recordVersion.toString(16)} / 0x${h.clientVersion.toString(16)}`,
  'supported_versions': h.versions.map((v) => name({ 0x0304: 'TLS1.3', 0x0303: 'TLS1.2', 0x0302: 'TLS1.1', 0x0301: 'TLS1.0' }, v)).join(', '),
  'session id length': h.sessionIdLength,
  'cipher suites (in order)': h.ciphers.map((c) => name(CIPHERS, c)),
  'extensions (in order)': h.extensions.map((e) => name(EXTENSIONS, e.type)),
  'supported_groups': h.groups.map((g) => name(GROUPS, g)),
  'key_share groups': h.keyShares.map((g) => name(GROUPS, g)),
  'signature_algorithms': h.sigalgs.map((s) => name(SIGALGS, s)),
  'ec_point_formats': h.ecPointFormats,
  'alpn': h.alpn,
  'psk_key_exchange_modes': h.pskModes,
  'session_ticket extension': h.ticketOffered,
  'pre_shared_key (resumption) in this flight': h.psk,
  'hello length': h.length,
});

const node = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rust = JSON.parse(readFileSync(process.argv[3], 'utf8'));
console.log(`Node ${node.node} (OpenSSL ${node.openssl}, undici ${node.undici}, ws ${node.ws}), recorded against b6f10295a\n`);
let differences = 0;
for (const kind of ['https', 'wss']) {
  const [n, r] = [show(parse(node[kind])), show(parse(rust[kind]))];
  console.log(`=== ${kind}`);
  for (const key of Object.keys(n)) {
    const same = JSON.stringify(n[key]) === JSON.stringify(r[key]);
    if (!same) differences += 1;
    console.log(`${same ? '  same ' : '  DIFF '} ${key}\n         node: ${JSON.stringify(n[key])}\n         rust: ${JSON.stringify(r[key])}`);
  }
}
console.log(`\n${differences} differing fields`);
