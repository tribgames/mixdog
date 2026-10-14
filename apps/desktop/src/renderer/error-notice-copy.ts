import { t } from './i18n';
import { localizedTurnFailureReason } from './transcript-failure-text';

// Runtime phrases use explicit translation keys so catalog extraction keeps
// them even though the failure classifier itself runs outside the renderer.
const copy = new Map<string, () => string>([
  ['An attached image exceeds the provider limit.', () => t('An attached image exceeds the provider limit.')],
  [
    'Reduce the image dimensions or number of images, then try again.',
    () => t('Reduce the image dimensions or number of images, then try again.'),
  ],
  ['The request exceeds the size limit.', () => t('The request exceeds the size limit.')],
  [
    'Reduce the attachments or request size, then try again.',
    () => t('Reduce the attachments or request size, then try again.'),
  ],
  ['The provider usage limit was reached.', () => t('The provider usage limit was reached.')],
  [
    'Wait for the limit to reset or choose another account.',
    () => t('Wait for the limit to reset or choose another account.'),
  ],
  ['Check the connection, then try again.', () => t('Check the connection, then try again.')],
  ['Check your sign-in or API key, then try again.', () => t('Check your sign-in or API key, then try again.')],
  ['The provider rejected this request.', () => t('The provider rejected this request.')],
  ['Review the request details before trying again.', () => t('Review the request details before trying again.')],
  ['Sign-in expired.', () => t('Sign-in expired.')],
  ['Sign in again from Providers.', () => t('Sign in again from Providers.')],
  ['Something went wrong.', () => t('Something went wrong.')],
  ['The provider is busy right now.', () => t('The provider is busy right now.')],
  ['Try again later or choose another model.', () => t('Try again later or choose another model.')],
  [
    'The provider is temporarily rate-limiting requests.',
    () => t('The provider is temporarily rate-limiting requests.'),
  ],
  ['Try again shortly.', () => t('Try again shortly.')],
  ["This model isn't included in your plan.", () => t("This model isn't included in your plan.")],
  [
    'Upgrade your plan, or choose another model or provider.',
    () => t('Upgrade your plan, or choose another model or provider.'),
  ],
  [
    'The provider account is out of credits or at its spend limit.',
    () => t('The provider account is out of credits or at its spend limit.'),
  ],
  [
    'Check your billing with the provider, then try again.',
    () => t('Check your billing with the provider, then try again.'),
  ],
  ["You don't have access to this resource.", () => t("You don't have access to this resource.")],
  [
    'Check your account permissions, or choose another model.',
    () => t('Check your account permissions, or choose another model.'),
  ],
  ['The conversation is too long for this model.', () => t('The conversation is too long for this model.')],
  ['Compact the conversation or start a new one.', () => t('Compact the conversation or start a new one.')],
  [
    'The provider refused this request under its safety policy.',
    () => t('The provider refused this request under its safety policy.'),
  ],
  ['Rephrase the request or choose another model.', () => t('Rephrase the request or choose another model.')],
  [
    'The requested service tier is unavailable right now.',
    () => t('The requested service tier is unavailable right now.'),
  ],
  ['Switch to the standard tier or try again later.', () => t('Switch to the standard tier or try again later.')],
]);

/** The next-step line of a described error, in the UI language. */
export function localizeErrorRecovery(presentation: {
  recovery: string;
  recoveryTemplate?: string;
  params?: Record<string, string> | null;
}): string {
  const { recovery, recoveryTemplate, params } = presentation;
  if (recoveryTemplate === 'Try again in {{wait}}.') return t('Try again in {{wait}}.', params ?? {});
  if (recoveryTemplate === 'It resets at {{time}}. Switch accounts or providers to continue now.') {
    return t('It resets at {{time}}. Switch accounts or providers to continue now.', params ?? {});
  }
  return localizeErrorCopy(recovery);
}

export function localizeErrorCopy(text: string): string {
  return copy.get(text)?.() ?? localizedTurnFailureReason(text);
}
