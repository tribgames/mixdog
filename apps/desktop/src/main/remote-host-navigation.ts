import { externalLinkTarget, isRemoteHostNavigation } from './remote-hosts';

interface NavigationEvent {
  isMainFrame: boolean;
  preventDefault(): void;
}

/** Only the window's own main frame is held to its host: a subframe's navigation is left to the frame's own rules, and
 *  only a link the user followed (not a redirect) is handed to the browser. */
export function hostNavigationGuards(hostUrl: string, openExternal: (target: string) => void) {
  return {
    onNavigate(event: NavigationEvent, url: string): void {
      if (!event.isMainFrame || isRemoteHostNavigation(hostUrl, url)) return;
      event.preventDefault();
      const target = externalLinkTarget(url);
      if (target) openExternal(target);
    },
    onRedirect(event: NavigationEvent, url: string): void {
      if (!event.isMainFrame || isRemoteHostNavigation(hostUrl, url)) return;
      event.preventDefault();
    },
  };
}
