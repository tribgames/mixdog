// Exact auxiliary floors for the token estimator. Count whole matching runs
// rather than allocating one array entry per non-whitespace character.
function matchingChars(text, expression) {
    let count = 0;
    for (const match of text.matchAll(expression)) count += match[0].length;
    return count;
}

export function denseTokenFloor(s) {
    let floor = 0;
    for (const match of s.matchAll(/[\x21-\x7e]{16,}/g)) {
        floor += match[0].length * (match[0].length >= 64 ? 0.65 : 0.5);
    }
    const encodedWords = s.match(/\b(?=[A-Za-z0-9]{8,}\b)(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g) || [];
    if (encodedWords.length >= 3) {
        const encodedChars = encodedWords.reduce((sum, word) => sum + word.length, 0);
        floor = Math.max(floor, (encodedChars * 0.5) + ((s.length - encodedChars) * 0.25));
    }
    return floor;
}

export function structuredTokenFloor(s) {
    const lines = s.split(/\r?\n/).filter(line => line.trim());
    // None of the structured-text conditions can apply to fewer than three
    // nonblank lines. Avoid scanning ordinary single-line messages again.
    if (lines.length < 3) return 0;
    const nonWhitespace = matchingChars(s, /\S+/g);
    if (nonWhitespace === 0) return 0;
    const structural = matchingChars(s, /[\[\]{}":,=<>|\\]+/g);
    const jsonLikeLines = lines.filter(line => /^\s*[\[{].*[\]}],?\s*$/.test(line)).length;
    return jsonLikeLines >= Math.ceil(lines.length / 2) || structural / nonWhitespace >= 0.12
        ? (nonWhitespace * 0.5) + ((s.length - nonWhitespace) * 0.25)
        : 0;
}
