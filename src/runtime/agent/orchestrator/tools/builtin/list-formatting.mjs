// ISO-ish mtime formatter shared by list / find_files. A single hyphen is
// used for zero/missing mtime so entries that failed stat still render a
// stable column.
export function formatMtime(mtimeMs) {
    if (!mtimeMs) return '-';
    return new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' ');
}

// Human-readable size column for list/find. Directories have no meaningful
// byte size (render '-'); files show KB so the model can spot a large file
// before reading it. Sub-1KB files round up to 1KB.
export function formatListSize(type, bytes) {
    if (type !== 'file') return '-';
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
    return `${Math.max(1, Math.round(n / 1024))}KB`;
}
