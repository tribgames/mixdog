//@@ browserScrollTextMatchExpression
(() => {
    const wanted = __MIXDOG_WANTED__;
    const token = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
    globalThis.__mixdogScrollToken = token;
    globalThis.__mixdogScrollTarget = null;
    const skipped = /^(script|style|noscript|template|title)$/;
    const rendered = (element) => {
      const view = element.ownerDocument.defaultView;
      if (!view) return false;
      const rect = element.getBoundingClientRect();
      // Either dimension at zero means the line has no place on the page.
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = view.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    };
    for (const root of (__MIXDOG_DOCUMENT_ROOTS__)()) {
      const scope = root === document ? (document.body || document.documentElement) : root;
      const owner = root === document ? document : root.ownerDocument;
      if (!scope || !owner) continue;
      const walker = owner.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = String(node.textContent || '');
        if (!value.toLowerCase().includes(wanted)) continue;
        const element = node.parentElement;
        if (!element || skipped.test(String(element.tagName || '').toLowerCase())) continue;
        if (!rendered(element)) continue;
        globalThis.__mixdogScrollTarget = element;
        // Quote the line around the phrase: on a long line its first
        // characters need not contain the match at all.
        const line = value.replace(/\s+/g, ' ').trim();
        const at = Math.max(0, line.toLowerCase().indexOf(wanted.replace(/\s+/g, ' ').trim()));
        const start = Math.max(0, at - 40);
        const end = Math.min(line.length, start + Math.max(120, wanted.length + 40));
        const text = (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
        return { token, found: true, text };
      }
    }
    return { token, found: false };
  })()
//@@ browserScrollTextApplyExpression
(() => {
    const mine = globalThis.__mixdogScrollToken === __MIXDOG_TOKEN__;
    const target = globalThis.__mixdogScrollTarget;
    // Every frame clears its own candidate, so a match never outlives the
    // observation that found it.
    globalThis.__mixdogScrollToken = null;
    globalThis.__mixdogScrollTarget = null;
    if (!mine || !target || !target.isConnected) return { scrolled: false };
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { scrolled: true };
  })()
