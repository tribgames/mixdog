/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) for the
 * authenticator keys saved with a login (credential-vault.ts `totpSecret`).
 * A key is the base32 text shown under a setup QR code, or the QR's own
 * `otpauth://totp/...` address with its `secret`, `digits`, `period` and
 * `algorithm` parameters. Codes are made in this process only.
 */
import { createHmac } from 'node:crypto';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpParameters {
  secret: Buffer;
  digits: 6 | 8;
  /** Seconds per step (30 unless the otpauth address says otherwise). */
  period: number;
  algorithm: TotpAlgorithm;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4226 asks for at least 128 bits; 80-bit keys are still common, nothing shorter. */
const MIN_SECRET_BYTES = 10;

/** RFC 4648 base32, case-insensitive; spaces, hyphens and `=` padding are ignored. */
export function decodeBase32(value: string): Buffer {
  const text = value
    .replace(/[\s-]+/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!text || !/^[A-Z2-7]+$/.test(text)) throw new TypeError('The authenticator key is not valid base32.');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** The key, digits, step and hash of a saved authenticator key; throws on anything invalid. */
export function parseTotpSecret(input: string): TotpParameters {
  const value = String(input || '').trim();
  let secret = value;
  let digits = 6;
  let period = 30;
  let algorithm = 'SHA1';
  if (/^otpauth:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError('The otpauth address is invalid.');
    }
    if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') {
      throw new TypeError('Only time-based (otpauth://totp) keys are supported.');
    }
    secret = url.searchParams.get('secret') || '';
    if (url.searchParams.has('digits')) digits = Number(url.searchParams.get('digits'));
    if (url.searchParams.has('period')) period = Number(url.searchParams.get('period'));
    if (url.searchParams.has('algorithm')) algorithm = String(url.searchParams.get('algorithm')).toUpperCase();
  }
  if (digits !== 6 && digits !== 8) throw new TypeError('An authenticator code has 6 or 8 digits.');
  if (!Number.isInteger(period) || period < 1 || period > 300) {
    throw new TypeError('The authenticator period is invalid.');
  }
  if (algorithm !== 'SHA1' && algorithm !== 'SHA256' && algorithm !== 'SHA512') {
    throw new TypeError('The authenticator algorithm is not supported.');
  }
  const key = decodeBase32(secret);
  if (key.length < MIN_SECRET_BYTES) throw new TypeError('The authenticator key is too short.');
  return { secret: key, digits, period, algorithm };
}

/** RFC 4226 HOTP value for `counter`. */
export function hotpCode(secret: Buffer, counter: number, digits: 6 | 8, algorithm: TotpAlgorithm = 'SHA1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac(algorithm.toLowerCase(), secret).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = hash.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code at `nowMs` (Unix epoch, T0 = 0). */
export function totpCode(parameters: TotpParameters, nowMs: number = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / parameters.period);
  return hotpCode(parameters.secret, counter, parameters.digits, parameters.algorithm);
}
