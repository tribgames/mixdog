import { useEffect, useState } from "react";

function useMediaBand(queryText: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(queryText).matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(queryText);
    if (!query) return undefined;
    const onChange = (): void => setMatches(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [queryText]);
  return matches;
}

export function useResponsiveShellBands() {
  const narrowShell = useMediaBand("(max-width: 760px)");
  const bottomSheetBand = useMediaBand("(max-width: 940px)");

  useEffect(() => {
    const root = document.documentElement;
    let settleTimer = 0;
    const onResize = (): void => {
      root.classList.add("mx-window-resizing");
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        root.classList.remove("mx-window-resizing");
        settleTimer = 0;
      }, 180);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(settleTimer);
      root.classList.remove("mx-window-resizing");
    };
  }, []);

  return { narrowShell, bottomSheetBand };
}
