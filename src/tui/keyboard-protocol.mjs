/**
 * src/tui/keyboard-protocol.mjs — shared keyboard-protocol negotiation state.
 *
 * A tiny, dependency-free module that records whether the terminal's kitty
 * keyboard protocol is actually active (confirmed by a query/response
 * negotiation, NOT guessed from an env allowlist). index.jsx sends the query at
 * startup and App.jsx flips this flag when the terminal answers with non-zero
 * kitty flags. PromptInput/TextEntryPanel read it to branch their Enter handling.
 *
 * Independent of that flag, Ctrl+J (0x0A) is always treated as a newline by the
 * editors, so a multiline message box works even when this stays false.
 */
let kittyActive = false;

export function setKittyProtocolActive(value) {
  kittyActive = !!value;
}

export function isKittyProtocolActive() {
  return kittyActive;
}
