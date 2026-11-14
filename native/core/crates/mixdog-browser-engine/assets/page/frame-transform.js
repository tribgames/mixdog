function(frame) {
  for (let node = frame; node; node = node.parentElement || node.getRootNode?.().host) {
    const transform = frame.ownerDocument.defaultView.getComputedStyle(node).transform;
    if (transform && transform !== 'none') return true;
  }
  return false;
}