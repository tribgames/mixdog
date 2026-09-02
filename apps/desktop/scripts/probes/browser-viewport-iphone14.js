(async () => {
  const waitFor = async (read, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Browser viewport probe timed out.');
  };
  const trigger = await waitFor(() => document.querySelector(
    '.browser-pane-viewport-control .mx-select-trigger',
  ));
  trigger.click();
  const menu = await waitFor(() => [...document.querySelectorAll('.mx-menu')]
    .find((candidate) => candidate.getAttribute('aria-label')?.startsWith(
      '브라우저 화면 크기:',
    )));
  const option = [...menu.querySelectorAll('.mx-menu-item')]
    .find((candidate) => candidate.textContent?.includes('iPhone 14 · 390×844'));
  if (!(option instanceof HTMLButtonElement)) {
    throw new Error('iPhone 14 viewport option is unavailable.');
  }
  const menuStyle = getComputedStyle(menu);
  option.click();
  const viewport = await waitFor(() => document.querySelector(
    '.browser-pane-viewport[data-viewport-preset="iphone-14"]',
  ));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const canvas = viewport.parentElement;
  const frame = viewport.getBoundingClientRect();
  const canvasRect = canvas?.getBoundingClientRect();
  const value = trigger.querySelector('.mx-select-value');
  return {
    trigger: {
      width: Math.round(trigger.getBoundingClientRect().width),
      valueDisplay: value ? getComputedStyle(value).display : null,
      ariaLabel: trigger.getAttribute('aria-label'),
    },
    menu: {
      backgroundColor: menuStyle.backgroundColor,
      optionCount: menu.querySelectorAll('.mx-menu-item').length,
    },
    frame: {
      preset: viewport.getAttribute('data-viewport-preset'),
      width: Math.round(frame.width),
      height: Math.round(frame.height),
      leftMargin: canvasRect ? Math.round(frame.left - canvasRect.left) : null,
      rightMargin: canvasRect ? Math.round(canvasRect.right - frame.right) : null,
      canvasBackground: canvas ? getComputedStyle(canvas).backgroundColor : null,
    },
    stored: Object.entries(localStorage)
      .filter(([key]) => key.startsWith('mixdog.browser-viewport.v1:')),
  };
})()
