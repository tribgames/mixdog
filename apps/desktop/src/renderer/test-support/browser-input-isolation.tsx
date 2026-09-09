import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import BrowserPane from '../BrowserPane.lazy';
import { useComposerFocus, usePaneTypingFocus } from '../use-composer-focus';

const fixture = window as unknown as {
  setSurfaceActive(value: boolean): void;
  setFixtureVisible(value: boolean): void;
  fixtureReady: boolean;
};
let visible = true;
// The harness window is never shown; exercise the visible-document client
// without activating an actual desktop window.
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
fixture.setFixtureVisible = value => { visible = value; document.dispatchEvent(new Event('visibilitychange')); };

function Fixture() {
  const [active, setActive] = useState(true);
  const [draft, setDraft] = useState('keep editing');
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  useComposerFocus({ textarea, transitioning: false, focusRequest: 0, paneActive: true });
  usePaneTypingFocus('editing', 'session');
  fixture.setSurfaceActive = setActive;
  fixture.fixtureReady = true;
  return <>
    <section data-pane-id="editing"><form className="composer">
      <textarea id="composer" ref={textarea} value={draft} onChange={event => setDraft(event.target.value)} />
      <output id="draft">{draft}</output>
    </form></section>
    <div id="browser-dock" style={{ width: 600, height: 400, marginTop: 30 }}>
      <BrowserPane sessionId="visible-session" active={active} foreground={active} focusAddressOnActivate={false} />
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
