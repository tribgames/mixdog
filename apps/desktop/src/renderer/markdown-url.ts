const safeProtocol = /^(?:https?|ircs?|mailto|xmpp)$/i;
const windowsPath = /^[a-z]:(?:[/\\]|%2f|%5c)/i;

/** Local hrefs must reach the click handler, never a browser navigation. */
export function isLocalMarkdownLink(value: string): boolean {
  const target = value.trim();
  if (!target || /^[#?]/.test(target) || target.startsWith("//")) return false;
  if (/^file:/i.test(target) || windowsPath.test(target)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(target);
}

/** Shared by react-markdown and the worker; local URLs are href-only. */
export function safeMarkdownUrl(value: string, key = "href"): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) return "";
  if (key === "href" && (/^file:/i.test(value) || windowsPath.test(value))) {
    return value;
  }
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  if (
    colon === -1
    || (slash !== -1 && colon > slash)
    || (questionMark !== -1 && colon > questionMark)
    || (numberSign !== -1 && colon > numberSign)
    || safeProtocol.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}
