const safeProtocol = /^(?:https?|ircs?|mailto|xmpp)$/i;
const windowsPath = /^[a-z]:(?:[/\\]|%2f|%5c)/i;

/** Local hrefs must reach the click handler, never a browser navigation. */
export function isLocalMarkdownLink(value: string): boolean {
  const target = value.trim();
  if (!target || /^[#?]/.test(target) || target.startsWith("//")) return false;
  if (/^file:/i.test(target) || windowsPath.test(target)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(target);
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Decode a local href once, preserving its absolute path outside Projects. */
export function localMarkdownPath(path: string): string {
  let target = String(path || "").trim();
  if (/^file:/i.test(target)) {
    target = target.replace(/^file:\/\/(?:localhost)?/i, "").replace(/^\/(?=[a-z]:)/i, "");
  }
  return decodePath(target.split(/[?#]/, 1)[0]).replace(/\\/g, "/");
}

/** A chat link's path relative to the conversation's Project, or null when it
 *  points outside it. A bare name (no folder) comes back unchanged so the
 *  caller can look it up in the Project. */
export function projectRelativeFilePath(projectPath: string, path: string): string | null {
  let target = localMarkdownPath(path);
  const root = String(projectPath || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const drivePath = (value: string) => /^[a-z]:\//i.test(value);
  if (drivePath(target) || target.startsWith("/")) {
    if (!root) return null;
    const fold = (value: string) => (drivePath(root) || drivePath(target) ? value.toLowerCase() : value);
    if (fold(target) !== fold(root) && !fold(target).startsWith(`${fold(root)}/`)) return null;
    target = target.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  // `./` or the Project path itself is the Project folder.
  return parts.length ? parts.join("/") : ".";
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
