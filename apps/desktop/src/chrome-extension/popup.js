const statusElement = document.querySelector('#status');
const pairingSection = document.querySelector('#pairing');
const accessSection = document.querySelector('#access');
const tokenInput = document.querySelector('#token');
const saveButton = document.querySelector('#save');
const toggleButton = document.querySelector('#toggle');
const errorElement = document.querySelector('#error');

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok && response?.error) throw new Error(response.error);
  return response;
}

async function refresh() {
  errorElement.textContent = '';
  const state = await request({ action: 'state' });
  pairingSection.hidden = state.paired;
  accessSection.hidden = !state.paired;
  statusElement.textContent = state.connected
    ? 'Connected to Mixdog'
    : state.paired ? 'Mixdog is not reachable' : 'Pairing required';
  toggleButton.disabled = !state.supported;
  toggleButton.textContent = state.allowed ? 'Stop allowing this tab' : 'Allow this tab';
  toggleButton.dataset.allowed = String(state.allowed);
}

saveButton.addEventListener('click', async () => {
  try {
    await request({ action: 'savePairing', pairingToken: tokenInput.value });
    tokenInput.value = '';
    await refresh();
  } catch (error) {
    errorElement.textContent = error.message;
  }
});

toggleButton.addEventListener('click', async () => {
  try {
    await request({
      action: toggleButton.dataset.allowed === 'true' ? 'disallowCurrent' : 'allowCurrent',
    });
    await refresh();
  } catch (error) {
    errorElement.textContent = error.message;
  }
});

void refresh().catch((error) => {
  errorElement.textContent = error.message;
});
