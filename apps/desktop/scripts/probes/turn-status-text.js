// Completed-turn status rows of the visible transcript (shows the "Auto <effort>"
// note when Auto reasoning picked the effort) plus the tail of the last reply.
(() => {
  const rows = [...document.querySelectorAll('.turn-status.complete')].map((node) => node.textContent?.trim());
  const replies = [...document.querySelectorAll('.transcript-item, .timeline-item')].map((node) => node.textContent?.trim() || '');
  return { statusRows: rows.slice(-3), lastItem: (replies.at(-1) || '').slice(-400) };
})()
