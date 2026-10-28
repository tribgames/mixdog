/*
 * app/use-btw-panel.mjs — the /btw side-question panel: its state, the
 * controller that fills it, and the controller's session/unmount lifecycle.
 */
import { useEffect, useRef, useState } from 'react';
import { createBtwController } from './btw-controller.mjs';

export function useBtwPanel({ store, sessionId }) {
  const [btwPanel, setBtwPanel] = useState(null);
  const btwRef = useRef(null);
  const sessionIdRef = useRef('');
  sessionIdRef.current = sessionId || '';
  if (!btwRef.current) {
    btwRef.current = createBtwController({
      getStore: () => store,
      setPanel: setBtwPanel,
      getSessionId: () => sessionIdRef.current,
    });
  }
  const btw = btwRef.current;
  // A side answer belongs to the conversation it was asked in: drop it on a
  // session change (new/resume/clear/switch) and cancel it on unmount.
  // biome-ignore lint/correctness/useExhaustiveDependencies(sessionId): session-change trigger; the controller reads the id through its getter
  useEffect(() => {
    btw.sync();
  }, [btw, sessionId]);
  useEffect(() => () => btw.dispose(), [btw]);
  return { btwPanel, btw };
}
