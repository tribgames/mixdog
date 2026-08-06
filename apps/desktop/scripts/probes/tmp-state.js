JSON.stringify({
  sidebarOpen: Boolean(document.querySelector('.session-sidebar')),
  buttons: [...document.querySelectorAll('button, a')].map((node) => ({
    l: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 20),
    c: node.getAttribute('class'),
  })).slice(0, 30),
})
