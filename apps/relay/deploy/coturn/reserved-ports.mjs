#!/usr/bin/env node
// Adds the coturn relay port range to net.ipv4.ip_local_reserved_ports without
// disturbing what else is reserved there, and takes back only what it added.
// The sysctl is a comma-separated list of ports and ranges (ip-sysctl): ports
// listed in it are never picked as ephemeral ports, while an explicit bind (how
// coturn takes its relay ports) is unaffected.
//
//   apply <min> <max> <record>   reserve the part of min-max that is not
//                                reserved yet; write that part to <record>
//   release <record>             un-reserve exactly the part <record> names
//   covers <min> <max>           exit 0 when min-max is wholly reserved
//
// RESERVED_PORTS_PROC names the sysctl file (tests point it elsewhere).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A port is 16 bits (RFC 9293 §3.1). */
const MAX_PORT = 65_535;

/** Sorted, merged (overlapping and adjacent ranges joined) [lo, hi] pairs. */
function normalize(ranges) {
  const merged = [];
  for (const [lo, hi] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

export function parseRanges(text) {
  const ranges = [];
  for (const token of String(text)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(token);
    if (!match) throw new RangeError(`not a port range: ${token}`);
    const lo = Number(match[1]);
    const hi = match[2] === undefined ? lo : Number(match[2]);
    if (lo > hi || hi > MAX_PORT) throw new RangeError(`not a port range: ${token}`);
    ranges.push([lo, hi]);
  }
  return normalize(ranges);
}

export const formatRanges = (ranges) => ranges.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}-${hi}`)).join(',');

/** `from` without any port in `removed`. */
export function subtractRanges(from, removed) {
  let rest = from;
  for (const [removeLo, removeHi] of removed) {
    rest = rest.flatMap(([lo, hi]) => {
      if (hi < removeLo || lo > removeHi) return [[lo, hi]];
      const kept = [];
      if (lo < removeLo) kept.push([lo, removeLo - 1]);
      if (hi > removeHi) kept.push([removeHi + 1, hi]);
      return kept;
    });
  }
  return rest;
}

/** The part of lo-hi that `current` does not reserve. */
export const missingRanges = (current, lo, hi) => subtractRanges([[lo, hi]], current);
export const coversRange = (current, lo, hi) => missingRanges(current, lo, hi).length === 0;
export const addRanges = (current, added) => normalize([...current, ...added]);

function readRanges(path) {
  return parseRanges(readFileSync(path, 'utf8'));
}

/** The ownership record is one line, `pending|applied|released [ranges]`. The
 *  ranges are the part of the reservation this tool owns: `pending` means the
 *  sysctl write is about to happen (or happened and was not confirmed), so they
 *  may or may not be reserved yet; `applied` means they are. Either way they are
 *  ours to take back, because they were unreserved when the record was made. */
function readRecord(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const match = /^(pending|applied|released)(?: (.*))?$/u.exec(text.trim());
  if (!match) throw new RangeError(`not an ownership record: ${path}`);
  return parseRanges(match[2] ?? '');
}

/** Whole-file replace (temp file + rename), so a record is never half written. */
function saveRecord(path, state, ranges, write) {
  const temp = `${path}.tmp`;
  write(temp, `${state}${ranges.length ? ` ${formatRanges(ranges)}` : ''}\n`);
  renameSync(temp, path);
}

function port(value) {
  const number = Number(value);
  if (!/^\d+$/u.test(value ?? '') || number < 1 || number > MAX_PORT) throw new RangeError(`not a port: ${value}`);
  return number;
}

/** `write` is the file writer (tests replace it to fail at a chosen step). */
export function run(
  argv,
  proc = process.env.RESERVED_PORTS_PROC || '/proc/sys/net/ipv4/ip_local_reserved_ports',
  write = writeFileSync
) {
  const [command, ...args] = argv;
  if (command === 'apply') {
    const [min, max, record] = args;
    const current = readRanges(proc);
    // A start that follows a crash (no stop ran) still owns what the last one added.
    const added = normalize([...readRecord(record), ...missingRanges(current, port(min), port(max))]);
    const merged = addRanges(current, added);
    // Ownership first: if the record cannot be saved nothing has changed, and if
    // this process dies after the sysctl write the record already names the part.
    saveRecord(record, 'pending', added, write);
    if (formatRanges(merged) !== formatRanges(current)) write(proc, `${formatRanges(merged)}\n`);
    saveRecord(record, 'applied', added, write);
    return `reserved ${min}-${max} (added: ${formatRanges(added) || 'nothing, already reserved'})`;
  }
  if (command === 'release') {
    const added = readRecord(args[0]);
    if (added.length === 0) return 'nothing to release';
    write(proc, `${formatRanges(subtractRanges(readRanges(proc), added))}\n`);
    saveRecord(args[0], 'released', [], write);
    return `released ${formatRanges(added)}`;
  }
  if (command === 'covers') {
    const current = readRanges(proc);
    if (!coversRange(current, port(args[0]), port(args[1]))) {
      throw new Error(`${args[0]}-${args[1]} is not wholly reserved (reserved: ${formatRanges(current) || 'none'})`);
    }
    return `reserved: ${formatRanges(current)}`;
  }
  throw new RangeError('usage: reserved-ports.mjs apply <min> <max> <record> | release <record> | covers <min> <max>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
