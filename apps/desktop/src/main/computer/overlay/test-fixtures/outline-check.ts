import assert from 'node:assert/strict';
import type { WebContents } from 'electron';

/** Pins prefers-reduced-motion through the already attached debugger, independent of the host's own setting. */
export async function emulateMotionPreference(contents: WebContents, value: 'no-preference' | 'reduce'): Promise<void> {
  await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  });
}

export async function checkOverlayOutline(contents: WebContents): Promise<void> {
  const active = await contents.executeJavaScript(`(() => {
    const outline = document.getElementById('outline');
    const highlight = outline.querySelector('.highlight');
    const animation = outline.getAnimations({subtree:true})[0];
    if (!animation) throw new Error('outline animation missing');
    const timing = animation.effect.getTiming();
    const running = animation.playState === 'running';
    animation.pause();
    const offsets = [.25, .75, 1.25].map(progress => {
      animation.currentTime = Number(timing.duration) * progress;
      return getComputedStyle(highlight).strokeDashoffset;
    });
    animation.currentTime = 0;
    animation.play();
    const bounds = highlight.getBoundingClientRect();
    const pill = document.getElementById('pill').getBoundingClientRect();
    const button = document.getElementById('toggle');
    const buttonBounds = button.getBoundingClientRect();
    return {
      running, repeating:timing.iterations === Infinity, offsets,
      stroke:getComputedStyle(highlight).stroke,
      strokeWidth:parseFloat(getComputedStyle(highlight).strokeWidth),
      followsPill:Math.abs(bounds.width-pill.width)<5 && Math.abs(bounds.height-pill.height)<5,
      controlsReachable:button.contains(document.elementFromPoint(
        buttonBounds.x+buttonBounds.width/2, buttonBounds.y+buttonBounds.height/2))
    };
  })()`);
  assert.equal(active.running, true);
  assert.equal(active.repeating, true);
  assert.notEqual(active.offsets[0], active.offsets[1], 'highlight must move around the outline');
  assert.equal(active.offsets[0], active.offsets[2], 'highlight must repeat seamlessly');
  assert.notEqual(active.stroke, 'none');
  assert.ok(active.strokeWidth > 0);
  assert.equal(active.followsPill, true);
  assert.equal(active.controlsReachable, true, 'outline must not intercept controls');

  await emulateMotionPreference(contents, 'reduce');
  try {
    const reduced = await contents.executeJavaScript(`(() => {
      const outline = document.getElementById('outline');
      const style = getComputedStyle(outline.querySelector('.highlight'));
      return {
        moving:outline.getAnimations({subtree:true}).some(animation=>animation.playState==='running'),
        stroke:style.stroke, dash:style.strokeDasharray
      };
    })()`);
    assert.equal(reduced.moving, false);
    assert.notEqual(reduced.stroke, 'none', 'reduced motion must retain a visible outline');
    assert.equal(reduced.dash, 'none');
  } finally {
    await emulateMotionPreference(contents, 'no-preference');
  }
}
