import { act } from 'react';

// A real pointer sequence (pointerdown -> pointerup -> click), so capture-phase
// outside-dismiss handlers see the press the way a mouse or touch produces it.
export async function press(element) {
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    await act(async () =>
      element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
    );
  }
}
