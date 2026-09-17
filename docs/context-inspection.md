# Context inspection

Open `/context` in the desktop or TUI to inspect the current session.

- The headline remains the last provider-measured input, including cached input.
  Unknown measurements remain unknown; estimates never replace that headline.
- The block map and categories are local estimates. Window view includes free
  space and the auto-compaction reserve; Fit magnifies occupied content.
- Select a category, then an entry to request its preview. Merely opening the
  dashboard returns names and estimates, not prompt or message bodies.
- Desktop updates follow session state. In the TUI, press `R` to refresh,
  `Z` to switch map scale, arrows to navigate or scroll, `Enter` to inspect,
  left arrow or Backspace to go back, and Escape to close.

The inspector uses the current in-flight transcript when present, otherwise
the committed transcript, and the current provider-scoped tool definitions.
It is a local inspection snapshot, not a capture of the provider's final wire
payload. Instruction sections share their parent message's estimate; tools
share the existing schema estimate. Neither category breakdown is an exact
provider tokenization or a billing report.

Preview requests must match the current session/model/content revision.
Changed context closes desktop previews and invalidates old preview requests.
Opaque reasoning signatures and binary media are excluded; terminal controls
are stripped. Previews are limited to 32,000 characters, with truncation
explicitly indicated. Preview bodies are not stored on sessions or in the
status cache. Inspection performs no model request and writes no prompt data.
