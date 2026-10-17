// Surfaces no first screen renders (a phone's cold open never shows them),
// kept out of the startup bundle. Each loads on its first mount or open, and
// the idle lane loads them all after boot (useAppModuleWarmup), so a later
// first open renders in the same frame instead of through a placeholder.
import { deferredModule } from './deferred-module';

/** The desktop sidebar's footer guide (phones never render it). */
export const starterGuideModule = deferredModule(() => import('./StarterGuide'));
/** Project settings / common memory editor, opened on demand. */
export const projectEditorDialogModule = deferredModule(() => import('./ProjectEditorDialog'));
/** The add-project dialog, opened on demand. */
export const projectAddDialogModule = deferredModule(() => import('./ProjectAddDialogHost'));
/** The pane side dock's Files tree. */
export const paneDockFilesModule = deferredModule(() => import('./pane-dock-files'));
/** The session Changes side view. */
export const sessionDiffPaneModule = deferredModule(() => import('./SessionDiffPane'));
/** The Visualize side view (the whole highlight.js set rides along): never in
 *  the idle lane below; the phone's sheet warm-up loads it (use-app-boot). */
export const visualizePaneModule = deferredModule(() => import('./VisualizePane'));
/** The Ports side view. */
export const serverPortsPanelModule = deferredModule(() => import('./ServerPortsPanel'));

export const FIRST_SCREEN_DEFERRED_MODULES = Object.freeze({
  'starter-guide': starterGuideModule,
  'project-editor': projectEditorDialogModule,
  'project-add': projectAddDialogModule,
  'dock-files': paneDockFilesModule,
  'session-diff': sessionDiffPaneModule,
  'server-ports': serverPortsPanelModule,
});
