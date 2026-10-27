/**
 * A local, phone-free, cursor-safe self-check of the screen source's math and
 * injector wire form. It injects nothing and captures no real screen, so it can
 * never move the cursor or touch a window — it is the part of the manual check
 * that is safe to run unattended on a working PC.
 *
 * It is a script, not a test file: the test runner (`scripts/test.mjs`) only
 * picks up `*.test.mjs` / `*-test.mjs`, so run it directly, from `apps/desktop`
 * (where `tsx` resolves); exit code 0 means every check passed:
 *
 *   node --import tsx src/main/remote-screen/screen-selfcheck.mjs
 *
 * It reports the capture plan for a sample display, the exact SendInput command
 * stream a harmless move-to-test-window-centre would produce, and confirms the
 * geometry mapping and stuck-key release invariants. The full on-device check
 * (capture one real frame, inject one real move inside a window the check
 * itself creates) is the Electron procedure in docs/remote-screen.md.
 */
import { lockScreenGeometry, mapScreenPointer, screenVideoSize } from './screen-geometry.ts';
import { screenInputCommands } from './screen-input-dispatch.ts';
import { formatScreenHostCommand } from './screen-input-host.ts';
import { ScreenInputRouter } from './screen-input-router.ts';

// A sample 1920x1080 display at 150% DPI, plus a second monitor to its left.
const primary = {
  screenId: '1',
  label: 'Primary',
  primary: true,
  scaleFactor: 1.5,
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  captureSourceId: 'screen:0:0',
};
const secondary = {
  screenId: '2',
  label: 'Left',
  primary: false,
  scaleFactor: 1,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  physical: { x: -1920, y: 0, width: 1920, height: 1080 },
  captureSourceId: 'screen:1:0',
};

function report(label, value) {
  console.log(`${label.padEnd(28)} ${value}`);
}

let failures = 0;
function check(label, condition) {
  report(label, condition ? 'ok' : 'FAIL');
  if (!condition) failures += 1;
}

for (const display of [primary, secondary]) {
  const size = screenVideoSize(display.physical);
  report(`${display.label} native pixels`, `${display.physical.width}x${display.physical.height}`);
  report(`${display.label} capture plan`, `${size.width}x${size.height} (source ${display.captureSourceId})`);
  const { geometry, mapping } = lockScreenGeometry(display, 1);
  report(
    `${display.label} locked geometry`,
    `css ${geometry.cssWidth}x${geometry.cssHeight} @${geometry.deviceScaleFactor}`
  );

  // A harmless move to the centre of a hypothetical test window at the display
  // centre: show where it lands in desktop pixels. No input is sent.
  const centre = mapScreenPointer(mapping, mapping.pixelWidth / 2, mapping.pixelHeight / 2);
  report(`${display.label} centre → desktop`, `(${centre.x}, ${centre.y})`);
  const move = screenInputCommands(
    { type: 'screen-pointer', action: 'move', x: mapping.pixelWidth / 2, y: mapping.pixelHeight / 2 },
    mapping,
    1
  );
  report(
    `${display.label} move command`,
    move.map((command, index) => formatScreenHostCommand(index + 1, command)).join(' | ')
  );
  console.log('');
}

// Invariants: a far-edge point clamps inside the display, an off-frame point is
// dropped, and a held chord releases exactly once — through a recording
// backend, so nothing reaches the real desktop.
const { mapping } = lockScreenGeometry(primary, 7);
check(
  'far edge clamps in-bounds',
  mapScreenPointer(mapping, mapping.pixelWidth, mapping.pixelHeight).x === primary.physical.width - 1
);
check('off-frame point dropped', mapScreenPointer(mapping, mapping.pixelWidth + 1, 0) === null);
check(
  'stale generation dropped',
  screenInputCommands({ type: 'screen-pointer', action: 'move', x: 0, y: 0 }, mapping, 6) === null
);

const sent = [];
const recorder = {
  send: async (command) => void sent.push(command),
  identity: () => ({ session: 1, desktop: 'default' }),
};
const router = new ScreenInputRouter({ desktop: recorder, secure: recorder });
await router.switchTo('desktop');
for (const input of [
  { type: 'screen-pointer', action: 'down', button: 'left', x: 0, y: 0 },
  { type: 'screen-key', action: 'down', vk: 0x11, scan: 0x1d, extended: false },
]) {
  await router.dispatch(screenInputCommands(input, mapping, 7), () => true);
}
sent.length = 0;
await router.releaseAll();
await router.releaseAll();
check('held chord releases once', sent.length === 2 && sent.every((command) => command.down === false));
check('nothing held after release', router.holdsInput() === false);

console.log('');
report('result', failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
