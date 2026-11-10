/**
 * mouse-input/sgr-buttons.mjs — SGR button-byte bit masks.
 *
 * Shared by the two paths that read modifier bits off the same byte: the wheel
 * router (ctrl+wheel zoom passthrough) and the button-gesture handling in
 * use-mouse-input.mjs.
 */
export const MOUSE_CTRL_MASK = 16;
// Bit 2 (4) of the SGR button byte = shift held during the click. Wheel/ctrl
// masking intentionally strips it for scroll routing; button-press handling
// reads it separately (before baseButton = button & 3 drops every modifier
// bit) so a shift-held left-click can extend an existing selection instead of
// starting a fresh one.
export const MOUSE_SHIFT_MASK = 4;
