// Phone/tablet shell behavior (remote browser + Capacitor shell): pin the
// layout to the VISUAL viewport. Browsers pan a focused input into view by
// scrolling the page, which pushes the header off-screen when the soft
// keyboard opens; instead the app shell shrinks to the visible height so the
// top bar stays fixed (user request). Desktop (fine pointer) is untouched.
(() => {
  const capacitor = (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
  if (!coarse && !capacitor?.isNativePlatform?.()) return;
  const root = document.documentElement;
  root.dataset.mixdogMobile = '1';
  const viewport = window.visualViewport;
  if (!viewport) return;
  let frame = 0;
  const apply = () => {
    frame = 0;
    root.style.setProperty('--mixdog-vvh', `${Math.round(viewport.height)}px`);
    // Undo any focus-scroll pan so the header never leaves the screen.
    if (window.scrollY !== 0 || viewport.offsetTop > 0) window.scrollTo(0, 0);
  };
  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  window.addEventListener('focusin', schedule);
  window.addEventListener('orientationchange', schedule);
  apply();
})();

export {};
