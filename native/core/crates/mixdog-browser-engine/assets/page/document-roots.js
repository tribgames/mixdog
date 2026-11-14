function() {
  const roots = [document];
  let scanned = 0;
  for (let index = 0; index < roots.length; index++) {
    const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (++scanned > 50000) throw new Error('document scan exceeded 50000 elements');
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }
  return roots;
}