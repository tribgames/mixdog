# Page flows

## Form

Use the latest returned refs → `fill.fields` (text, `values` for selects,
`checked` for boxes) → submit via `click` or `fill` with `submit:true` → verify
with `expect`. When labels are known, `fill.fields` with `target:{name}` per
item needs no snapshot first.

- One checkbox or radio is `fill` with `checked` instead of `text`. Custom
  checkboxes hide the native input behind a label; `fill` and `click` land on
  the label automatically.
- Rich text editors (`contenteditable`) are filled as typed input over a
  select-all, so `fill` works on them like on a textarea.
- `fill` sets a value in one step and is the default; `type` sends one real
  keystroke per character, which a search box, autocomplete, or combobox that
  only reacts to keys needs. After typing into one, read the returned snapshot
  and click the matching suggestion instead of pressing Enter; press Enter only
  when no suggestion appears.
- `select` without `values` lists a native dropdown's options, marking the
  `[selected]` and `[disabled]` ones, and changes nothing — use it instead of a
  snapshot when only the choices are unknown. A custom (non-native) dropdown is
  opened with `click` and read from the fresh snapshot; `select` on it takes
  exactly one value.

## PDF address

This browser has no PDF viewer, so such a page reports that it is a PDF and
carries nothing to act on; read the file from its URL with a file-reading tool
instead of clicking around the page.

## Multi-page task

Keep one snapshot per page; `list_tabs` when targets or ownership are unknown,
then act on the intended tab. Use `back` instead of re-navigating when history
suffices; forward is a `navigate` to the URL the earlier snapshot showed. A
popup the page opens (`window.open`, an OAuth or sign-in window) becomes a
background page the reply names ("Opened "popup-N" as a new page"), and the
visible page does not switch: act on it by that name, and check `list_tabs`
before concluding no popup opened.

## Downloads / uploads

`downloads` lists and can `wait` for and `attach` the newest file (≤ 8 MiB). A
wait pins the newest download, or the next one to start; provide `downloadId`
to choose another. `upload` takes absolute `paths`; clicking a non-file ref
opens its chooser first, and a target that opens none receives the files as a
drop. A target that takes neither says so instead.

## Drag and drop

`drag` moves between two ends addressed the same way: `ref`+`targetRef`,
`target`+`dropTarget`, or grounded coordinates. Drop zones and cards often have
no accessible name, so a CSS `selector` target is usually the shortest route. A
page that answers the gesture with its own HTML5 drag — kanban cards, sortable
lists, file drop zones — is carried through to a real drop, so the reply
reflects the dropped state, not just a pointer that moved.

## Dialogs

An alert/confirm/prompt halts the flow; answer it with `handle_dialog`
(`accept`, optional `promptText`) and read the fresh snapshot. The blocked reply
says which side of the dialog your action is on: "The action ran" means the
gesture happened (it likely opened the dialog) and must not be repeated; "This
action was not sent" means the dialog was already up, so repeat it after
answering only if it is still needed.