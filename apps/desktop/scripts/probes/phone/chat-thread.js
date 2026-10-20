// phone-shot.mjs step: open a chat thread by sending a message from the new-session composer.
// A fresh instance has no model sign-in, so the thread shows the user message and the
// provider notice; start the instance with --copy-auth to get a real reply.
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const box = document.querySelector('textarea[aria-label]');
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Hello from the phone layout check');
box.dispatchEvent(new Event('input', { bubbles: true }));
await wait(400);
document.querySelector('.send-button').click();
await wait(2500);
return box.value === '';


