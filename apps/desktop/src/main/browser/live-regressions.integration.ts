import assert from 'node:assert/strict';
import type { WebContents } from 'electron';

type Command = (input: Record<string, unknown>) => Promise<{ text: string; image?: { data?: string } }>;

/** Reproduce the scrolled/mobile and hidden-window failures through the real host. */
export async function runLiveBrowserRegressions(
  command: Command,
  origin: string,
  contentsWithUrl: (part: string) => WebContents,
  imagePixel: (data: string, x: number, y: number) => [number, number, number]
) {
  const tab = 'live-regressions';
  const url = `${origin}/secondary?live-regressions=1`;
  await command({ action: 'navigate', url, tab, background: true });
  const guest = contentsWithUrl('live-regressions=1');
  const originalZoom = guest.getZoomFactor();
  try {
    guest.setZoomFactor(0.75);
    await command({
      action: 'evaluate',
      tab,
      script: `(() => {
        document.body.style.cssText='margin:0;background:white';
        document.body.innerHTML='<div style="height:100px;background:linear-gradient(90deg,red 80%,lime 80%)"></div>'
          + '<div style="height:1700px"><p id="out">READY</p>'
          // Chromium 150+ (Electron 43) exposes an option only inside its listbox.
          + '<input aria-label="City"><div role="listbox"><div id="option" role="option">Busan</div></div>'
          + '<div id="list" style="height:100px;overflow:auto"><div style="height:1000px">Rows</div></div>'
          + '<div id="shadow"></div></div>'
          + '<button id="bottom" style="display:block;box-sizing:border-box;border:0;width:100%;height:200px;background:blue">Bottom probe</button>';
        document.querySelector('#option').onmousedown=event=>{
          document.querySelector('input').value='Busan';
          document.querySelector('#out').textContent='SELECTED_Busan';
          event.currentTarget.hidden=true;
        };
        window.regressionClicks=0;
        document.querySelector('#bottom').onclick=()=>{
          document.querySelector('#out').textContent='BOTTOM_CLICKED_'+(++window.regressionClicks);
        };
        document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML=
          '<style>/* HIDDEN_CSS_SENTINEL */ p {color:green}</style><p>Shadow visible</p>';
        return 'ready';
      })()`,
    });
    const selected = await command({
      action: 'click',
      target: { role: 'option', name: 'Busan', exact: true },
      expect: { text: 'SELECTED_Busan' },
      tab,
    });
    assert.match(selected.text, /value="Busan"/);
    const nested = await command({ action: 'scroll', target: { selector: '#list' }, dy: 500, tab });
    assert.doesNotMatch(nested.text, /No observable change/);
    const read = await command({ action: 'read', tab, maxChars: 10000 });
    assert.match(read.text, /Shadow visible/);
    assert.doesNotMatch(read.text, /HIDDEN_CSS_SENTINEL/);
    for (const mobile of [false, true]) {
      await command({
        action: 'emulate',
        tab,
        width: mobile ? 390 : 1000,
        height: 400,
        deviceScaleFactor: 1,
        mobile,
        touch: true,
      });
      await command({ action: 'scroll', text: 'Bottom probe', tab });
      for (const pointer of ['mouse', 'touch']) {
        const count = (mobile ? 2 : 0) + (pointer === 'mouse' ? 1 : 2);
        await command({
          action: 'click',
          target: { selector: '#bottom' },
          pointer,
          tab,
          expect: { text: `BOTTOM_CLICKED_${count}` },
        });
      }
      const shot = await command({ action: 'snapshot', mode: 'visual', fullPage: true, format: 'png', tab });
      assert.ok(shot.image?.data);
      const right = imagePixel(shot.image.data, 0.95, 0.02);
      const bottom = imagePixel(shot.image.data, 0.95, 0.95);
      assert.deepEqual(right, [0, 255, 0], `right edge omitted (mobile=${mobile})`);
      assert.deepEqual(bottom, [0, 0, 255], `bottom edge omitted (mobile=${mobile})`);
    }
    await command({ action: 'emulate', tab, reset: true });
    await command({
      action: 'evaluate',
      tab,
      script: `(() => {
        document.body.innerHTML='<h1>Private capture fixture</h1>'
          + '<div hidden><input id="hidden-input" value="original"></div>'
          + '<input id="first"><input id="second">'
          + '<input id="private-input" type="password"><p id="echo"></p>';
        window.firstWrites=0;
        document.querySelector('#first').oninput=()=>{
          window.firstWrites++;
          document.querySelector('#second').disabled=true;
        };
        return 'ready';
      })()`,
    });
    await assert.rejects(
      command({
        action: 'fill',
        tab,
        target: { selector: '#hidden-input' },
        text: 'must-not-write',
      }),
      /element is hidden/
    );
    assert.equal(await guest.executeJavaScript("document.querySelector('#hidden-input').value"), 'original');
    await assert.rejects(
      command({
        action: 'fill',
        tab,
        fields: [
          { target: { selector: '#first' }, text: 'once' },
          { target: { selector: '#second' }, text: 'never' },
        ],
      }),
      /field 2 of 2; 1 field\(s\) completed[\s\S]*not replayed/
    );
    assert.deepEqual(
      await guest.executeJavaScript(
        "({first:document.querySelector('#first').value,second:document.querySelector('#second').value,writes:window.firstWrites})"
      ),
      { first: 'once', second: '', writes: 1 }
    );

    const secret = 'SYNTHETIC_CREDENTIAL_FIXTURE_1234';
    await command({ action: 'fill', tab, target: { selector: '#private-input' }, text: secret });
    // A focused password field withholds every capture; this one is masked and blurred.
    await command({ action: 'evaluate', tab, script: "document.querySelector('#private-input').blur(); true" });
    const masked = await command({ action: 'snapshot', tab, mode: 'visual' });
    assert.ok(masked.image?.data, 'a masked password field does not disable ordinary screenshots');
    await command({
      action: 'evaluate',
      tab,
      script: "document.querySelector('#echo').textContent=document.querySelector('#private-input').value; true",
    });
    const safeText = await command({ action: 'read', tab });
    assert.doesNotMatch(safeText.text, /SYNTHETIC_CREDENTIAL_FIXTURE/);
    for (const options of [
      { mode: 'visual' },
      { mode: 'both' },
      { mode: 'visual', target: { selector: '#echo' } },
      { mode: 'visual', fullPage: true },
      { mode: 'visual', format: 'pdf' },
    ]) {
      await assert.rejects(command({ action: 'snapshot', tab, ...options }), /Visual output withheld/);
    }
    await command({
      action: 'evaluate',
      tab,
      script:
        "document.querySelector('#echo').textContent=''; document.querySelector('#private-input').type='text'; true",
    });
    await assert.rejects(command({ action: 'snapshot', tab, mode: 'visual' }), /Visual output withheld/);
  } finally {
    guest.setZoomFactor(originalZoom);
    await command({ action: 'close_tab', tab });
  }
}
