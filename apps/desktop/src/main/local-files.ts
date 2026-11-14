import { isAbsolute, resolve } from 'node:path';

import { pathText } from '../shared/remote-arguments';

/** Shape-validated absolute path for trusted local-file operations. */
export function absoluteLocalPath(value: unknown): string {
  const text = pathText(value);
  if (!isAbsolute(text)) throw new TypeError('path must be absolute.');
  return resolve(text);
}
