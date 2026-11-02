# Showing special targets

Read when opening a web URL, showing a deck or document, or when `annotate` or
`capture` reports the panel is hidden.

- A web URL is opened alone, never mixed with files; marking, capturing, or
  closing a web page belongs to `browser`. `open` of a URL reports the page id
  (`p…`); pass it as `browser`'s `tab`.
- Decks and documents: the panel shows the converted pages; still run the
  owning skill's own render review — the panel is for the user, not your QC.
- `annotate` and `capture` need the tab on screen (`export` of an HTML page
  does not). When they report the panel is hidden, tell the user to open it
  rather than retrying.
