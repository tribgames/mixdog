// Shared viewport writer. Web and Electron use the same 940/760 CSS bands;
// remote only marks itself so the - ㅁ x caption reserve can stay off.

function remoteSurface(): boolean {
  return Boolean((window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer);
}

function syncViewportVars(): void {
  const root = document.documentElement;
  const visual = window.visualViewport;
  const width = visual?.width ?? window.innerWidth;
  const height = visual?.height ?? window.innerHeight;
  root.style.setProperty("--vvw", `${Math.round(width)}px`);
  root.style.setProperty("--vvh", `${Math.round(height)}px`);
  root.style.setProperty("--vv-offset-left", `${Math.round(visual?.offsetLeft ?? 0)}px`);
  root.style.setProperty("--vv-offset-top", `${Math.round(visual?.offsetTop ?? 0)}px`);
}

function syncShellFlags(): void {
  const root = document.documentElement;
  if (remoteSurface()) {
    root.dataset.mixdogRemote = "1";
    return;
  }
  delete root.dataset.mixdogRemote;
}

export function installShellViewport(): () => void {
  const sync = () => {
    syncViewportVars();
    syncShellFlags();
  };
  sync();
  const visual = window.visualViewport;
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  visual?.addEventListener("resize", sync);
  visual?.addEventListener("scroll", sync);
  return () => {
    window.removeEventListener("resize", sync);
    window.removeEventListener("orientationchange", sync);
    visual?.removeEventListener("resize", sync);
    visual?.removeEventListener("scroll", sync);
  };
}
