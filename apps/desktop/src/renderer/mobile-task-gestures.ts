export type MobileTaskSwipeAction = 'previous-tab' | 'next-tab' | null;

export function classifyMobileTaskSwipe({
  deltaX,
  deltaY,
}: {
  deltaX: number;
  deltaY: number;
}): MobileTaskSwipeAction {
  const horizontal = Math.abs(deltaX);
  const vertical = Math.abs(deltaY);
  if (horizontal >= 56 && horizontal > vertical * 1.2) {
    return deltaX < 0 ? 'next-tab' : 'previous-tab';
  }
  return null;
}
