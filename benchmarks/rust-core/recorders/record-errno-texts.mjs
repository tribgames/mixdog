#!/usr/bin/env node
// Golden twin of the errno wording a failed file operation carries: libuv's description of every
// errno the publication path (open, write, fsync, rename, unlink) can fail with, as Node's own
// `util.getSystemErrorMap()` prints it, and the whole message of three real failed calls.
//
//   node benchmarks/rust-core/recorders/record-errno-texts.mjs
import { openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { getSystemErrorMap } from 'node:util';
import { FIXTURES_ROOT } from './lib/common.mjs';

const NAMES = [
  'EPERM', 'ENOENT', 'EIO', 'EBADF', 'EACCES', 'EBUSY', 'EEXIST', 'EXDEV', 'ENOTDIR', 'EISDIR', 'EINVAL', 'EMFILE',
  'ENFILE', 'ENOSPC', 'EROFS', 'EMLINK', 'ENAMETOOLONG', 'ENOTEMPTY', 'ELOOP', 'ETXTBSY', 'EFBIG', 'ENOMEM',
  'ENOTSUP', 'EAGAIN', 'EINTR', 'EFAULT', 'ENODEV', 'ESPIPE', 'EOVERFLOW', 'ECANCELED', 'ETIMEDOUT', 'ENXIO',
];
const described = {};
for (const [, [name, description]] of getSystemErrorMap()) described[name] = description;
const errnos = Object.fromEntries(NAMES.map((name) => [name, described[name]]));

const missing = (name) => (process.platform === 'win32' ? `C:\\mixdog-no-such-dir\\${name}` : `/mixdog-no-such-dir/${name}`);
const real = [];
for (const [syscall, run] of [
  ['open', () => openSync(missing('a.json'), 'wx')],
  ['rename', () => renameSync(missing('a.json.tmp'), missing('a.json'))],
  ['unlink', () => unlinkSync(missing('a.json'))],
]) {
  try {
    run();
  } catch (error) {
    real.push({ syscall, message: error.message, code: error.code, errno: error.errno });
  }
}
writeFileSync(`${FIXTURES_ROOT}/desktop/settings/errno-texts-twin.json`, `${JSON.stringify({ domain: 'errno-texts-twin', recorder: 'benchmarks/rust-core/recorders/record-errno-texts.mjs', platform: process.platform, errnos, real }, null, 1)}\n`);
console.log(`recorded ${Object.keys(errnos).length} errnos, ${real.length} calls`);
