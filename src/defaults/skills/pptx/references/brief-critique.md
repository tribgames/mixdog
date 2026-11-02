# Brief, facts, and scored critique

The contract every office deliverable written to a brief shares: a deck, and a
document, workbook, or designed PDF a decision depends on. A deck fills every
key; a document or workbook needs `subject/audience/action`, `sources` when
material was supplied, and `facts:`. `concept:` is optional free text
everywhere, never a catalogue id.

## 1. Brief
Where it goes: a deck's script opens with it as a `//` comment block; an HTML
source carries it as a `<!-- BRIEF … -->` comment (one `key: value` per line);
`create` takes it as `design:{ brief:'<key: value lines>' }`.

```
// BRIEF
// subject/audience/action: <what this deck must make someone do>
// concept: <optional free-text design intent; no catalogue id required>
// reading mode: presentation | balanced | text · argument mode: pyramid | narrative | instructional | showcase | briefing
// directions: A <style, seed hue, pairing, motif — one-sentence note> · B <…> · selected: <A|B> · why: <visible reason from trial, or fixed-template constraint>
// style: <direction.md §3 id or custom> · palette: hue <deg> [· accent hue <deg>] · accent: <hex> · type: MODE <mode> → body <pt> · script: ko | ja | zh | latin · pairing: serif | weight | concord · fonts: noto | safe
// motif: <the selected style's device on anchors> · rhythm: anchor, dense, breathing, dense, ... , anchor
// sources: <file, document, or url the deck is built from> · <…>        (only when material was supplied)
// facts: F1 <value> — <source> · F2 <value> — <source> · ...        (or `sample — <why no source>` when every figure is illustrative)
// slide plan: 1 job: cover · move: <what the reader now holds> · composition: <the page move in words> · carriers: <…>
//   2 job: evidence · relationship: contrast · move: <…> · composition: <…> · carriers: chart, takeaway · texture: prose · rhythm: dense
//   ... N job: closing · move: <…> · composition: <…> · carriers: statement
```

- A thin request gets a defensible brief invented from the subject, never blank fields.
- A deck's plan line names, for every slide, its job, relationship, move, composition move, carriers, texture, and rhythm before any geometry exists. A single-slide specimen is not gated, and a stale slide count stays information (`plan_count_mismatch`).
- The `facts:`, `directions:`, and `slide plan:` lines may wrap across comment lines; each continuation line is read as more ` · ` items — so ` · ` is the separator and never appears inside a value or a source (write "관측치와 측정", not "관측치·측정"; a fact cut at an inner ` · ` silently disappears and every figure it carried becomes `number_without_fact`).

## 2. Facts and sources
- `facts:` lists each number the deliverable will show, with its source (a page, a cell, a URL, or "user brief"). Dates and slide numbers are exempt.
- A chart series is one fact listing its values in order (`F3 운영비 1Q–6Q 10.5 10.8 9.1 7.9 7.0 6.5 — 재무팀 시트 B4:G4`); the values in the chart (a script's `chart()` call, a `data-chart`) are copied from that line.
- With source material, the fact sheet is written first; without it, the facts come from the request and say so.
- A sketch or template with no source at all declares `facts: sample — <why>`: every figure is illustrative, a deck lands with `factsMode: 'sample'`, and the delivery tells the user the numbers are examples.
- When the deliverable is built from files or pages the user gave, `sources:` names them and every fact's source points where a reader can open it — a page (`p.12`), a cell (`Sheet1!B4`), a section (`§3`), or a URL. A figure that came from somewhere else (a conversation, a live system) says so in its own source.
- What the runtime reads back: a deck's `author` refuses a figure no fact covers (`facts_gate`, the figures listed per slide; the previous deck and its session stay untouched, and the answer is the facts line, not a retry); `qa` reports `number_without_fact` (a figure in a body, table, title, label, or insight that no fact carries), `facts_missing`, `facts_illustrative`, and `fact_without_locator` (advisory, when sources are named).

## 3. Scored critique (finalize)
`finalize design:{ reviewed:true, reviewToken:<token of the last complete render>, critique:[…] }` with one entry per slide or rendered page (keyed `slide` or `page`):
- `verdict:'pass'`; five integer 1-5 scores as top-level fields — `hierarchy`, `balance`, `legibility`, `cohesion`, `evidence`; a slide- or page-specific `note` of 40+ characters; `fixes` (work still owed — applied fixes belong in `note`); and `checks`.
- Judge those axes from the rendered page before assigning scores; never increase a score to unlock finalize. A score of 3 or lower on any axis, or any failed check, marks the page as still needing polish, and finalize holds it.
- An anchor entry (cover, section, closing) carries `role: 'anchor'` (or its job name): its `evidence` score is recorded but does not gate, since a statement or a picture is the carrier there; the other four axes gate as usual.
- **Hard rule — checks are the slide's own questions**: `checks` holds at least three `{ item, pass }` entries per slide, each a binary question written from that slide's plan line (a document's: its brief) and facts before looking at the render. Two kinds answer different failures and a slide needs both: what the page owes on its own (the promised carrier is there, the emphasis lands on the claim, the takeaway states a consequence) and, when the deliverable was built from supplied material, what the page owes its sources — one question per page asking whether everything it shows is traceable to them, since a figure or a claim the material does not contain is the failure a clean render hides best ("the accent bar is Q4, the category the title names", "the 38 → 0 figures match F1 and F4", "the 184,200건 in the title matches F1", "the total row is set apart", "the takeaway states a consequence, not a topic"), then answered against the render. Generic questions ("is the slide readable") do not count; a `pass: false` blocks finalize until the source is fixed. → runtime `visual_critique_incomplete`, `visual_critique_needs_polish`
- Automated `quality.score` is diagnostic, not a design grade; `automatedReady` and `visualReview` are separate evidence. Neither predicts the user's acceptance, and the recorded review is the agent's, not the user's approval.
