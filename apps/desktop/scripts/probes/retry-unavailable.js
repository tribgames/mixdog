// Presses "retry" on an unavailable-session cover, if one is showing.
(async () => {
  const cover = document.querySelector('.session-unavailable');
  if (!cover) return { cover: false };
  const button = cover.querySelector('button');
  button?.click();
  await new Promise((r) => setTimeout(r, 2500));
  return {
    cover: true,
    clicked: Boolean(button),
    stillUnavailable: Boolean(document.querySelector('.session-unavailable')),
  };
})();
