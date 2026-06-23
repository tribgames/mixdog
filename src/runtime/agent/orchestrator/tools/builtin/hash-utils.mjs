import { createHash } from 'crypto';

export function hashText(text) {
    if (Buffer.isBuffer(text)) return createHash('sha256').update(text).digest('hex');
    return createHash('sha256').update(String(text ?? '')).digest('hex');
}
