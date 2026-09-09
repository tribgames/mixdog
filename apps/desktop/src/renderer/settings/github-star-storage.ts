const STARRED_KEY = 'mixdog.desktop.github-starred.tribgames.mixdog';

export function readGithubStarred(): boolean {
  try {
    return window.localStorage.getItem(STARRED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function rememberGithubStarred(starred: boolean): boolean {
  if (starred) {
    try {
      window.localStorage.setItem(STARRED_KEY, 'true');
    } catch { /* Keep the current UI state when storage is unavailable. */ }
  }
  return starred;
}
