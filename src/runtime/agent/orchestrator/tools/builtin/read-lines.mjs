export function splitRawLinesForHeadTail(content) {
    const lines = String(content ?? '').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

export function displayLineForRead(rawLine, index) {
    let line = String(rawLine ?? '');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (index === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
    return line;
}
