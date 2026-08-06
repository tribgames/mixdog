// What the live window actually renders (diagnosis helper).
(() => {
  const textareas = [...document.querySelectorAll('textarea')].map((element) => ({
    label: element.getAttribute('aria-label') || '',
    placeholder: element.placeholder || '',
    className: element.className,
    visible: element.getClientRects().length > 0,
    disabled: element.disabled,
  }));
  const panes = [...document.querySelectorAll('[class*="pane"]')]
    .map((node) => node.className)
    .filter((value, index, all) => typeof value === 'string' && all.indexOf(value) === index)
    .slice(0, 25);
  return {
    title: document.title,
    textareas,
    inputs: [...document.querySelectorAll('input')].length,
    panes,
    bodyClass: document.body.className,
    rootChildren: [...(document.getElementById('root')?.children || [])].map((node) => node.className),
  };
})()
