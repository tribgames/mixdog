/**
 * app-view/text-entry-labels.mjs — prompt-kind → panel label mapping.
 *
 * One responsibility: the title/hint/action/prompt labels a provider or
 * settings prompt shows, derived from its `kind`. No JSX: floating-panel.jsx
 * feeds the result straight into TextEntryPanel.
 */

export function providerPromptFields(providerPrompt) {
  let title;
  let hint;
  let promptLabel;
  switch (providerPrompt.kind) {
    case 'api-key':
      title = `${providerPrompt.mode === 'replace' ? 'Replace' : 'Set'} API key · ${providerPrompt.label}`;
      hint = [
        providerPrompt.envName ? `Env: ${providerPrompt.envName}` : '',
        providerPrompt.source ? `Current: ${providerPrompt.source}` : '',
        providerPrompt.keyUrl ? `Get a key: ${providerPrompt.keyUrl}` : '',
        'Stored in the OS keychain.',
      ]
        .filter(Boolean)
        .join(' · ');
      promptLabel = 'API key > ';
      break;
    case 'oauth-code':
      title = providerPrompt.label;
      hint = providerPrompt.hint || 'Paste the browser code.';
      promptLabel = 'Paste code here if prompted > ';
      break;
    case 'openai-usage-session':
      title = 'OpenAI Usage · Session Key';
      hint =
        'Paste an OpenAI dashboard/session key for the undocumented credit lookup. It is stored in the OS keychain.';
      promptLabel = 'Session key > ';
      break;
    default:
      title = `Base URL · ${providerPrompt.label}`;
      hint = `Default: ${providerPrompt.defaultURL}`;
      promptLabel = 'Base URL > ';
  }
  return { title, hint, promptLabel };
}

export function settingsPromptFields(kind) {
  let actionLabel = 'save';
  let promptLabel = 'Value > ';
  switch (kind) {
    case 'skill-use':
      actionLabel = 'run';
      promptLabel = 'Command > ';
      break;
    case 'autoclear-provider':
      promptLabel = 'Duration > ';
      break;
    case 'project-new':
      actionLabel = 'open';
      promptLabel = 'Path > ';
      break;
    case 'project-create-confirm':
      actionLabel = 'confirm';
      promptLabel = 'Create? (y/n) > ';
      break;
    case 'project-rename':
      actionLabel = 'rename';
      promptLabel = 'Name > ';
      break;
    case 'core-add':
      actionLabel = 'add';
      promptLabel = 'Sentence > ';
      break;
    case 'core-edit':
      promptLabel = 'Sentence > ';
      break;
    case 'core-delete-confirm':
      actionLabel = 'confirm';
      promptLabel = 'Delete? (y/n) > ';
      break;
  }
  return { actionLabel, promptLabel };
}
