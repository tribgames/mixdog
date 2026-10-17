import { deferredModule } from './deferred-module';

type StudioViewModule = typeof import('./StudioView');

/** The Studio pane chunk. Once the idle lane (or a hover on a Studio row/tab)
 *  has loaded it, ReadyStudioPane renders it synchronously, so a first open
 *  never passes through a Suspense placeholder frame. */
export const studioViewModule = deferredModule<StudioViewModule>(() => import('./StudioView'));

export function loadStudioViewModule(): Promise<StudioViewModule> {
  return studioViewModule.load();
}
