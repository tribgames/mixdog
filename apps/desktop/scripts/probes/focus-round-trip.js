// Focus must not touch rendering: capture every pane's painted state, cycle
// focus across panes, and report what changed.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const snapshot = () => [...document.querySelectorAll('.pane-leaf')].map((leaf, index) => {
    const surface = leaf.querySelector('.pane-chat-surface');
    const text = surface?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const route = [...leaf.querySelectorAll('button')]
      .map((node) => node.textContent?.trim() || '')
      .find((value) => /Opus|Sonnet|Claude|모델/.test(value)) || '';
    const scroller = leaf.querySelector('[class*="scroll"]');
    return {
      index,
      focused: Boolean(leaf.closest('.pane-cell')?.className.includes('is-focused')),
      chars: text.length,
      head: text.slice(0, 40),
      tail: text.slice(-40),
      route,
      scrollTop: Math.round(scroller?.scrollTop || 0),
    };
  });
  const before = snapshot();
  const leaves = [...document.querySelectorAll('.pane-leaf')];
  const click = async (leaf) => {
    const body = leaf.querySelector('.pane-surface-body') || leaf;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
    await wait(1200);
  };
  // Round trip: every pane takes focus once, then the first pane takes it back.
  for (const leaf of leaves) await click(leaf);
  if (leaves[0]) await click(leaves[0]);
  await wait(1500);
  const after = snapshot();
  return {
    before,
    after,
    changed: after.map((pane, index) => ({
      index,
      charsDelta: pane.chars - (before[index]?.chars ?? 0),
      routeLost: Boolean(before[index]?.route && !pane.route),
      routeBefore: before[index]?.route || '',
      routeAfter: pane.route,
      textChanged: pane.head !== before[index]?.head || pane.tail !== before[index]?.tail,
      scrollDelta: pane.scrollTop - (before[index]?.scrollTop ?? 0),
    })),
  };
})()
