// The name this window's own prompts and approvals are stamped with: the host's
// name in the local window, the paired client's name on a remote surface. A
// transcript never says "from <device>" about that device itself.
import { useEffect, useState } from 'react';

/** The viewing device's name: null while unknown, '' when the host could not
 *  say (an older host without the method), which names every device. */
export function useViewerDevice(): string | null {
  const [device, setDevice] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const api = window.mixdogDesktop;
    const settle = (name: string) => {
      if (live) setDevice(name);
    };
    if (!api?.viewerDevice) {
      settle('');
      return;
    }
    Promise.resolve(api.viewerDevice())
      .then((name) => settle(typeof name === 'string' ? name : ''))
      .catch(() => settle(''));
    return () => {
      live = false;
    };
  }, []);
  return device;
}
