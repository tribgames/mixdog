// phone-shot.mjs step: open the phone drawer on the Agents page.
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
if (!document.querySelector('.sidebar-drawer-frame[data-state=open]')) {
  document.querySelector('.workspace-tab-home').click();
  await wait(600);
}
const agents = document.querySelector('.workbench-side-icon-bar button[data-side-view=agents]');
if (!agents.classList.contains('selected')) agents.click();
await wait(600);
return document.querySelectorAll('.agent-chat-row-main').length;

