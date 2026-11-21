type CommandSurfaceModule = typeof import('./CommandSurface');

let commandSurfaceModulePromise: Promise<CommandSurfaceModule> | null = null;

export function loadCommandSurfaceModule(): Promise<CommandSurfaceModule> {
  // A rejected import must not stay cached, or every retry would replay the
  // same failure for the window's lifetime.
  commandSurfaceModulePromise ||= import('./CommandSurface').catch((error) => {
    commandSurfaceModulePromise = null;
    throw error;
  });
  return commandSurfaceModulePromise;
}
