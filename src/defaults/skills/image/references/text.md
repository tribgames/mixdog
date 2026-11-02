# Text inside the image

- **Text only when wanted.** A field for copy gets no text; the deliverable or the page sets its own type over it.
- **When text is wanted, it is exact**: the words in quotes, the language and script, the font style, the approximate size, the placement, and "once, with no other readable text". Spell uncommon words letter by letter. Korean: write the prompt in English and quote only the Hangul string; start with short label-length strings.
- **Copy that must be exact is composited, not generated.** Packaging, UI, legal, or brand copy is generated as an empty reserved area (`no text` in that region) and set afterwards with a real font by the deliverable or an image tool.
- **Inspect rendered text every time**; garbled glyphs are common. One targeted text-only edit pass may follow, with the same locks; if spelling still drifts, stop and composite.
