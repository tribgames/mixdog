import { createReadStream } from 'fs';

function isJsWhitespaceCodeUnit(code) {
    return code === 32
        || (code >= 9 && code <= 13)
        || code === 0x00A0
        || code === 0x1680
        || (code >= 0x2000 && code <= 0x200A)
        || code === 0x2028
        || code === 0x2029
        || code === 0x202F
        || code === 0x205F
        || code === 0x3000
        || code === 0xFEFF;
}

async function countTextStatsStreamingUtf8(fullPath, size) {
    if (!size) return { lines: 0, words: 0, bytes: 0 };
    const stream = createReadStream(fullPath, { encoding: 'utf-8', highWaterMark: 1024 * 1024 });
    let lines = 0;
    let words = 0;
    let inWord = false;
    let lastChar = '';
    for await (const chunk of stream) {
        if (!chunk) continue;
        for (let i = 0; i < chunk.length; i++) {
            const code = chunk.charCodeAt(i);
            if (code === 10) lines++;
            if (isJsWhitespaceCodeUnit(code)) {
                inWord = false;
            } else if (!inWord) {
                words++;
                inWord = true;
            }
            lastChar = code;
        }
    }
    if (lastChar && lastChar !== 10) lines++;
    return { lines, words, bytes: size };
}

export async function countTextStatsStreaming(fullPath, size) {
    if (!size) return { lines: 0, words: 0, bytes: 0 };
    const stream = createReadStream(fullPath, { highWaterMark: 1024 * 1024 });
    let lines = 0;
    let words = 0;
    let inWord = false;
    let lastByte = -1;
    for await (const chunk of stream) {
        if (!chunk) continue;
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            if (b >= 0x80) {
                stream.destroy();
                return countTextStatsStreamingUtf8(fullPath, size);
            }
            if (b === 10) lines++;
            if (b === 32 || (b >= 9 && b <= 13)) {
                inWord = false;
            } else if (!inWord) {
                words++;
                inWord = true;
            }
            lastByte = b;
        }
    }
    if (lastByte !== -1 && lastByte !== 10) lines++;
    return { lines, words, bytes: size };
}
