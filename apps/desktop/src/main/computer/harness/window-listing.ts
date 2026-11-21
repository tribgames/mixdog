/** The window id on the first list_windows line `matches` accepts, or ''. */
export function windowIdWhere(listing: string, matches: (line: string) => boolean): string {
  return (
    listing
      .split(/\r?\n/)
      .find(matches)
      ?.match(/^(hwnd:0x[0-9a-f]+)/i)?.[1] || ''
  );
}

export function windowIdByTitle(listing: string, title: string): string {
  return windowIdWhere(listing, (line) => line.includes(`"${title}"`));
}
