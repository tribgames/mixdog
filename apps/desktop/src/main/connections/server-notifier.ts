// The bound on what the OS shows of a notification: a session title is one line and both texts are clipped. The
// notifications of a server window (a final answer, an approval waiting, the link lost or back) are the core's.

/** A server names its sessions and supplies their previews: the OS gets
 *  bounded text, one line for the title. */
export const NOTIFICATION_TITLE_CHARS = 120;
export const NOTIFICATION_BODY_CHARS = 240;
const clip = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};
export function boundedNotification(content: { title: string; body: string }): { title: string; body: string } {
  return {
    title: clip(content.title.replace(/\s+/g, ' ').trim(), NOTIFICATION_TITLE_CHARS),
    body: clip(content.body.trim(), NOTIFICATION_BODY_CHARS),
  };
}
