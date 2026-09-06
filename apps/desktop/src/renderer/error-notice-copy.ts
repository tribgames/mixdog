import { t } from "./i18n";
import { localizedTurnFailureReason } from "./transcript-failure-text";

// Runtime phrases use explicit translation keys so catalog extraction keeps
// them even though the failure classifier itself runs outside the renderer.
const copy = new Map<string, () => string>([
  ["An attached image exceeds the provider limit.", () => t("An attached image exceeds the provider limit.")],
  ["Reduce the image dimensions or number of images, then try again.", () => t("Reduce the image dimensions or number of images, then try again.")],
  ["The request exceeds the size limit.", () => t("The request exceeds the size limit.")],
  ["Reduce the attachments or request size, then try again.", () => t("Reduce the attachments or request size, then try again.")],
  ["The provider usage limit was reached.", () => t("The provider usage limit was reached.")],
  ["Wait for the limit to reset or choose another account.", () => t("Wait for the limit to reset or choose another account.")],
  ["Check the connection, then try again.", () => t("Check the connection, then try again.")],
  ["Check your sign-in or API key, then try again.", () => t("Check your sign-in or API key, then try again.")],
  ["The provider rejected this request.", () => t("The provider rejected this request.")],
  ["Review the request details before trying again.", () => t("Review the request details before trying again.")],
  ["Something went wrong.", () => t("Something went wrong.")],
]);

export function localizeErrorCopy(text: string): string {
  return copy.get(text)?.() ?? localizedTurnFailureReason(t(text));
}
