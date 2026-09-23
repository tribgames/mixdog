/**
 * Fixture servers for the browser host integration run: a bare WebSocket
 * echo endpoint, a cross-origin frame document, and the page server whose
 * routes back every scenario (forms, dialogs, downloads, PDFs, stalls).
 * They only serve documents — no scenario state lives here.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';

/** Accepts one upgrade and echoes back every unmasked text frame it receives. */
export function createBrowserSocketFixture(): Server {
  const socketFixture = createServer();
  socketFixture.on('upgrade', (request, socket) => {
    const key = String(request.headers['sec-websocket-key'] || '');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.on('data', (frame) => {
      if (frame.length < 6) return;
      const opcode = frame[0] & 0x0f;
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      const length = frame[1] & 0x7f;
      if (length >= 126 || frame.length < 6 + length) return;
      const mask = frame.subarray(2, 6);
      const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = frame[6 + index] ^ mask[index % 4];
      }
      const response = Buffer.from(`echo:${payload.toString('utf8')}`);
      socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response]));
    });
  });
  return socketFixture;
}

/** The document embedded as a cross-origin iframe by the /frames route. */
export function createBrowserFrameFixture(): Server {
  return createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Cross-origin frame</title>
      <p>Cross-frame evidence</p>
      <button onclick="this.textContent = 'Frame clicked'">Frame action</button>
      <div id="shadow-host"></div><script>
        document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML =
          '<span class="shadow-evidence">Shadow frame evidence</span>';
      </script>`);
  });
}

/**
 * The scenario page server. `frameOrigin` is read per request because the
 * cross-origin fixture only has a port once it is listening, and the stalled
 * responses are handed back so the caller can destroy them on teardown.
 */
export function createBrowserPageFixture(frameOrigin: () => string): {
  server: Server;
  stalledResponses: Set<ServerResponse>;
} {
  const stalledResponses = new Set<ServerResponse>();
  const fixture = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    const path = new URL(request.url || '/', origin).pathname;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/unsaved') {
      response.end(`<!doctype html><title>Unsaved fixture</title>
        <p id="state">Unsaved work</p>
        <button id="arm" onclick="window.onbeforeunload = (event) => { event.preventDefault(); return 'stay'; };
          document.querySelector('#state').textContent = 'Guard armed';">Arm guard</button>`);
      return;
    }
    if (path === '/refused-resource') {
      response.end(`<!doctype html><title>Refused resource fixture</title>
        <img src="http://10.255.255.1/pixel.png" alt=""><p>Refused resource page</p>`);
      return;
    }
    if (path === '/frameset') {
      response.end(`<html><head><title>Frameset fixture</title></head>
        <frameset cols="50%,50%"><frame src="/frameset-pane?side=Left"><frame src="/frameset-pane?side=Right">
        <noframes>Frames are not rendering.</noframes></frameset></html>`);
      return;
    }
    if (path === '/frameset-pane') {
      const side = new URL(request.url || '/', origin).searchParams.get('side') === 'Right' ? 'Right' : 'Left';
      response.end(`<!doctype html><title>${side} pane</title><p>${side} pane text</p>`);
      return;
    }
    if (path === '/tall') {
      response.end(`<!doctype html><title>Tall fixture</title>
        <section id="tall-report" aria-label="Tall report"
          style="height:1400px;background:linear-gradient(#fff,#468)">Tall report</section>`);
      return;
    }
    if (path === '/root') {
      response.end(`<!doctype html><title>Root fixture</title>
        <p id="state">Waiting</p>
        <label>Password <input type="password" value="do-not-leak-password"></label>
        <button onclick="setTimeout(() => { const state = document.querySelector('#state'); const count = Number(state.dataset.spa || 0) + 1; state.dataset.spa = count; state.textContent = 'SPA done ' + count; }, 100)">Update SPA</button>
        <button onclick="document.querySelector('#state').textContent = confirm('Proceed with fixture?') ? 'Dialog accepted' : 'Dialog dismissed'">Open dialog</button>        <a href="${origin}/popup" target="_blank">Open popup</a>
        <button onclick="setTimeout(() => { const target = document.querySelector('#self-heal'); target.replaceWith(target.cloneNode(true)); }, 700)">Arm rerender</button>
        <button id="self-heal" onclick="document.querySelector('#state').textContent = 'Self-heal clicked'">Self-heal target</button>
        <label>First name <input aria-label="First name"></label>
        <label>Last name <input aria-label="Last name"></label>
        <label>Preferred role <select aria-label="Preferred role" onchange="document.querySelector('#state').textContent = 'Role ' + this.value"><option value="designer">Designer</option><option value="engineer">Engineer</option></select></label>
        <button id="mouse-options" onmousedown="document.querySelector('#state').textContent = 'Mouse ' + event.button + ' ctrl=' + event.ctrlKey + ' shift=' + event.shiftKey">Mouse options</button>
        <label>Default checkbox <input type="checkbox" onchange="document.querySelector('#state').textContent = this.checked ? 'Checkbox checked' : 'Checkbox unchecked'"></label>
        <label>Type probe <input aria-label="Type probe" onkeydown="window.typeKeys = (window.typeKeys || '') + event.key" oninput="document.querySelector('#state').textContent = 'Typed ' + this.value"></label>
        <label>Upload fixture <input type="file" aria-label="Upload fixture" onchange="document.querySelector('#state').textContent = 'Uploaded ' + (this.files[0]?.name || 'none')"></label>
        <button id="proxy-upload" onclick="document.querySelector('#hidden-upload').click()">Choose attachment</button>
        <input id="hidden-upload" type="file" style="display:none" onchange="document.querySelector('#state').textContent = 'Proxy uploaded ' + (this.files[0]?.name || 'none')">
        <button id="drop-zone" ondragover="event.preventDefault()"
          ondrop="event.preventDefault(); document.querySelector('#state').textContent = 'Dropped ' + (event.dataTransfer.files[0]?.name || 'none')">Drop zone</button>
        <button id="hover-target" onmouseenter="document.querySelector('#state').textContent = 'Semantic hovered'">Hover target</button>
        <button id="drag-source" style="position:fixed;left:600px;top:200px" onmousedown="window.fixtureDragging=true">Drag source</button>
        <button id="drag-target" style="position:fixed;left:820px;top:200px" onmousemove="if (event.buttons === 1 && window.fixtureDragging) document.querySelector('#state').textContent = 'Mouse dragged'" onmouseup="window.fixtureDragging=false">Drag target</button>
        <div id="card-source" draggable="true" style="position:fixed;left:600px;top:300px;width:120px;height:40px;background:#cde"
          ondragstart="event.dataTransfer.setData('text/plain', 'card-42')">Card source</div>
        <div id="card-target" style="position:fixed;left:820px;top:300px;width:120px;height:40px;background:#dec"
          ondragover="event.preventDefault()"
          ondrop="event.preventDefault(); document.querySelector('#state').textContent = 'Card dropped ' + event.dataTransfer.getData('text/plain')">Card target</div>
        <div id="city-combo">
          <button id="city-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="city-list"
            onclick="const open = this.getAttribute('aria-expanded') === 'true'; this.setAttribute('aria-expanded', String(!open)); document.querySelector('#city-list').style.display = open ? 'none' : 'block'">Choose city</button>
          <ul id="city-list" role="listbox" style="display:none">
            <li role="option" data-value="seoul" onclick="document.querySelector('#state').textContent = 'City Seoul'">Seoul</li>
            <li role="option" data-value="busan" onclick="document.querySelector('#state').textContent = 'City Busan'">Busan</li>
          </ul>
        </div>
        <ul id="products">
          <li class="product" data-price="1200">Widget one</li>
          <li class="product" data-price="3400">Widget two</li>
          <li class="product" data-price="5600">Widget three</li>
        </ul>
        <table id="ledger"><thead><tr><th>Last name</th><th>First name</th></tr></thead>
          <tbody><tr><td>Smith John</td><td>Jr</td></tr><tr><td>Doe</td><td>Jane</td></tr></tbody></table>
        <p id="visual-state">Visual idle</p>
        <div aria-hidden="true" onmouseenter="document.querySelector('#visual-state').textContent = 'Visual hovered'"
          onclick="const state = document.querySelector('#visual-state'); const count = Number(state.dataset.count || 0) + 1; state.dataset.count = count; state.textContent = 'Visual clicked ' + count"
          style="position:fixed;left:600px;top:100px;width:120px;height:60px;background:#fc0"></div>
        <p>${'x'.repeat(2800)} Extended snapshot tail</p>
        <script>console.info('fixture-info-ready'); console.warn('fixture-warning-ready');</script>`);
      return;
    }
    if (path === '/target-regressions') {
      response.end(`<!doctype html><title>CSS target regression fixture</title>
        <div aria-hidden="true">
          <input id="first" data-key="a  b"><input id="second" data-key="a b">
        </div>
        ${Array.from(
          { length: 51 },
          (_, index) => `<button data-many aria-label="${index === 0 || index === 50 ? 'Duplicate' : `Other ${index}`}"
            onclick="window.fixtureClicks++">Item ${index}</button>`
        ).join('')}
        <script>window.fixtureClicks = 0;</script>`);
      return;
    }
    if (path === '/popup') {
      response.end('<!doctype html><title>Popup fixture</title><p>Popup ready</p>');
      return;
    }
    if (path === '/secondary') {
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secondary fixture</title>
        <style>body{min-height:1800px;background:linear-gradient(to bottom,#f44 0 33%,#4f4 33% 66%,#44f 66% 100%)}#touch-target{position:fixed;left:100px;top:100px;width:120px;height:50px;background:#4af}#touch-drag-source{position:fixed;left:100px;top:200px;width:80px;height:50px}#touch-drag-target{position:fixed;left:330px;top:200px;width:50px;height:50px}#input-probe{position:fixed;right:0;bottom:0;max-width:360px;pointer-events:none}</style>
        <p>Secondary page</p>
        <button id="touch-target" ontouchstart="this.textContent='Touched'">Touch target</button>
        <button id="touch-drag-source" ontouchmove="if (event.touches[0] && event.touches[0].clientX > 300) document.querySelector('p').textContent='Touch dragged'">Touch drag source</button>
        <button id="touch-drag-target">Touch drag target</button>
        <p id="input-probe">Input idle</p>
        <div id="scroll-box" style="position:fixed;left:300px;top:300px;width:260px;height:120px;overflow:auto;border:1px solid">
          <button>Scroll inside</button><div style="width:900px;height:900px"></div>
        </div>
        <script>
          window.inputProbe = [];
          const sourceRect = document.querySelector('#touch-drag-source').getBoundingClientRect();
          window.sourceRectLabel = 'source:'
            + [sourceRect.left, sourceRect.top, sourceRect.right, sourceRect.bottom].map(Math.round).join(',');
          document.querySelector('#input-probe').textContent = window.sourceRectLabel;
          for (const type of ['touchstart','touchmove','touchend','pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','click']) {
            document.addEventListener(type, (event) => {
              const point = event.touches?.[0] || event.changedTouches?.[0] || event;
              window.inputProbe.push(type + ':' + (event.target?.id || event.target?.tagName)
                + '@' + Math.round(point.clientX || 0) + ',' + Math.round(point.clientY || 0));
              const events = window.inputProbe.length <= 8
                ? window.inputProbe.join(' | ')
                : [...window.inputProbe.slice(0, 3), ...window.inputProbe.slice(-5)].join(' | ');
              document.querySelector('#input-probe').textContent = window.sourceRectLabel + ' | ' + events;
            }, true);
          }
        </script>`);
      return;
    }
    if (path === '/api/echo-headers') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ headers: request.headers }));
      return;
    }
    if (path === '/api/submit') {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.setHeader('x-fixture', 'network-detail');
        response.end(JSON.stringify({ ok: true, received: JSON.parse(body) }));
      });
      return;
    }
    if (path === '/download') {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.setHeader('content-disposition', 'attachment; filename="browser-fixture.txt"');
      response.end('download attachment ready');
      return;
    }
    if (path === '/long-text') {
      response.end(
        `<!doctype html><title>Long text fixture</title><h1>Long text</h1><p>${'a long paragraph of page text. '.repeat(3_000)}</p>`
      );
      return;
    }
    if (path === '/protected') {
      response.statusCode = 401;
      response.setHeader('www-authenticate', 'Basic realm="fixture"');
      response.end('<!doctype html><title>Protected fixture</title><p>Sign in required</p>');
      return;
    }
    if (path === '/paper.pdf') {
      // Served for display rather than as an attachment: the guest carries no
      // PDF viewer, so the browser has to turn the link into something the
      // caller can still read instead of an empty page.
      response.setHeader('content-type', 'application/pdf');
      response.end('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
      return;
    }
    if (path === '/initial-dialog') {
      response.end(`<!doctype html><title>Initial dialog fixture</title>
        <script>document.documentElement.dataset.answer = confirm('Initial fixture dialog') ? 'yes' : 'no';</script>
        <p>Initial dialog complete</p>`);
      return;
    }
    if (path === '/frames') {
      response.end(`<!doctype html><title>Frame host fixture</title>
        <h1>Frame host</h1><iframe src="${frameOrigin()}/frame"></iframe>`);
      return;
    }
    if (path === '/same-process-frames') {
      response.end(`<!doctype html><title>Same-process frame host</title>
        <h1>Same-process host</h1><iframe src="/same-process-child"></iframe>`);
      return;
    }
    if (path === '/same-process-child') {
      response.end(`<!doctype html><p>Same-process evidence</p>
        <label>Frame input <input></label>
        <button onclick="document.querySelector('p').textContent = 'Frame value: ' + document.querySelector('input').value">Echo same-process frame</button>`);
      return;
    }
    if (path === '/recovered') {
      response.end('<!doctype html><title>Recovered fixture</title><p>Queue recovered</p>');
      return;
    }
    if (path === '/missing') {
      response.statusCode = 404;
      response.end('<!doctype html><title>Missing fixture</title><p>Nothing here</p>');
      return;
    }
    if (path === '/stall') {
      response.write('<!doctype html><title>Stalled fixture</title><p>Still loading');
      stalledResponses.add(response);
      response.once('close', () => stalledResponses.delete(response));
      return;
    }
    response.statusCode = 404;
    response.end('<!doctype html><title>Missing</title>');
  });
  return { server: fixture, stalledResponses };
}
