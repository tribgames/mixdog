/**
 * The panes a tab shows: page-server URLs for its files, and the pane of
 * inline content (a scripted page when one can be served).
 */
import type { VisualizeInlineContent, VisualizePaneView } from '../../shared/visualize';
import { inlineContentIsPage } from '../../shared/visualize-inline-page';
import type { VisualizeServiceContext } from './context';
import { type FileTarget, inlinePane, remoteTargetOf } from './tab-state';

export function createPanes(ctx: Pick<VisualizeServiceContext, 'deps'>) {
  const { deps } = ctx;
  return {
    /** Each target is served from its own root. */
    async preparePanes(targets: FileTarget[]): Promise<VisualizePaneView[]> {
      return Promise.all(
        targets.map(async (target) => ({
          kind: target.kind,
          label: target.label,
          target: target.target,
          url: await deps.preparePane(target),
          // What the user's panel feedback names: never a host path.
          file: remoteTargetOf(target),
        }))
      );
    },
    /** The pane that shows `content`: a scripted page from the page server's
     *  virtual lease for chart / html (a page pane, so it gets HTML-pane
     *  protections), else (or when no page can be served) the static render. */
    async inlinePaneFor(content: VisualizeInlineContent): Promise<VisualizePaneView> {
      const pane = inlinePane(content);
      if (!deps.prepareInlinePage || !inlineContentIsPage(content)) return pane;
      try {
        return { ...pane, kind: 'html', url: await deps.prepareInlinePage(content) };
      } catch (error) {
        console.warn('visualize inline page unavailable, showing the static render:', (error as Error).message);
        return pane;
      }
    },
  };
}

export type Panes = ReturnType<typeof createPanes>;
