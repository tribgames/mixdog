/** Address-bar entry → URL: explicit schemes pass through, host-shaped text
 * gets https://, anything else becomes a web search. */
export function normalizeAddressInput(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^https?:/i.test(text)) return text;
  const hostLike = /^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(text)
    || /^localhost(:\d+)?([/?#]\S*)?$/i.test(text)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]\S*)?$/i.test(text);
  if (hostLike && !/\s/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
