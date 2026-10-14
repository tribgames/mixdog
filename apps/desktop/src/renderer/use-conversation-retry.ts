import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { turnPromptText, turnSampledOutput } from './transcript-rows';

/** Session retry: a failed turn that produced no output resubmits its prompt
 *  and the runtime rewinds the unanswered copy, so the model sees the prompt
 *  once; a turn that already sampled output continues from where it stopped. */
export function useConversationRetry(
  settledItems: TranscriptItem[],
  settledTurnKeys: string[],
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>
) {
  const retryTurn = async (turnKey: string): Promise<boolean> => {
    const text = turnPromptText(settledItems, settledTurnKeys, turnKey);
    if (!text) return false;
    const prompt = turnSampledOutput(settledItems, settledTurnKeys, turnKey)
      ? t('Continue from where you left off.')
      : text;
    return (await submit(prompt, { retryFailedTurn: true })) === true;
  };
  return { retryTurn };
}
