// Environment failures (the machine, not the bytes): an error `code` such as
// ERR_*, ENOMEM or MODULE_NOT_FOUND, or an out-of-memory / allocation-failed
// message. Anything else, e.g. a decoder's bad-bytes error, is a property of
// the input. Wrapped causes are followed.
const ENV_CODE = /^(ERR_|ENOMEM$|MODULE_NOT_FOUND$)/;
const ENV_MESSAGE = /out of memory|allocation failed|cannot allocate memory/i;

export function isEnvironmentError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (typeof current.code === 'string' && ENV_CODE.test(current.code)) return true;
    if (ENV_MESSAGE.test(String(current.message || ''))) return true;
  }
  return false;
}
