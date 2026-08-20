// Loader for the /context · /usage · /doctor · /inherit dialog.
//
// The chunk used to be reached only through App's own lazy() call, so the
// FIRST open always paid a relay round trip before the dialog could paint —
// on a phone there is no hover to warm it on and no idle pass ever touched it
// (user: 컨텍스트 팝업 열 때가 많이 느리네). Sharing one promise lets the
// idle warmup and the real open join the same load.
type CommandSurfaceModule = typeof import("./CommandSurface");

let commandSurfaceModulePromise: Promise<CommandSurfaceModule> | null = null;

export function loadCommandSurfaceModule(): Promise<CommandSurfaceModule> {
  // A rejected import must not stay cached, or every retry would replay the
  // same failure for the window's lifetime.
  commandSurfaceModulePromise ||= import("./CommandSurface").catch((error) => {
    commandSurfaceModulePromise = null;
    throw error;
  });
  return commandSurfaceModulePromise;
}
