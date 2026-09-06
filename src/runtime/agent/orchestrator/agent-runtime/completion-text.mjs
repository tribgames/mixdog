// Plain text of a maintenance completion (title, commit message): a bare
// string, a string content, or the joined text parts of structured content.
export function resultText(result) {
    if (typeof result === 'string') return result;
    if (typeof result?.content === 'string') return result.content;
    if (Array.isArray(result?.content)) {
        return result.content
            .map((part) => part?.type === 'text' ? String(part.text || '') : '')
            .filter(Boolean)
            .join('\n');
    }
    return '';
}
