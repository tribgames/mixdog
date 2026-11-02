# Common flows and troubleshooting

**Type into a native field** — fresh observation → `act`: click the field ref,
`type` text, optional `key` Enter → inspect the returned value. Use `verify`
only if the result does not establish the required value or completion state.

**Keyboard-driven navigation** — `act` with `key` steps such as `ctrl+s`;
the act settles itself. Verify with `verify` rather than another capture.

**Dialog appears mid-sequence** — `act` halts when the settle check sees it; a
dialog that opens later arrives in the next command's
`windows_opened_since_last_action`. Use its successful successor observation to
handle the dialog; capture only if it is unusable. Returning to the original
window also requires a fresh observation, whether returned by the action or
obtained through `capture`. For `focus_required` /
`dialog_key_unsupported` refusals, follow the dialog rule in SKILL.md.

**Reading a screen for the user** — `capture` with `mode=ax` for text-heavy
UI, `som` when you need to point at things, `image_output=file` for large
frames that should stay out of the conversation.

## Troubleshooting

| Symptom | Do |
|---|---|
| Ambiguous `app` | `list` and pass the exact `window_id`. |
| Empty semantics | `capture` with `include_ocr:true` (set `ocr_language`), or `mode=som`. |
| Refs rejected as expired | Use a successful recovery observation if returned; otherwise capture again. |
| `act` stopped early | Read `recovery` and the observation; the target transitioned. |
| Coordinates refused (`pixel_unavailable`) | Use fresh semantic refs if available; never use unavailable pixels or a desktop-region substitute. |
| OCR unavailable, pixels usable | Continue from the fresh image/frame. Do not retry the missing recognizer unchanged or install a language pack without approval. |
| Input completed, observation failed | Capture only to inspect the result; do not repeat completed or uncertain input. |
| Definite background no-input refusal | Choose a supported route within scope; strict background-only work cannot escalate without approval. |
| Target-local cleanup unconfirmed | Hand off window recovery to the user. Do not reset the guard or replay input. |
| Input backend error | `diagnose`, report the cause, and recover through the same tool. |
