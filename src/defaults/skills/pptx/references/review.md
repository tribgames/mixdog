# Direction trials and independent review

Use this procedure for a new visual direction, substantive redesign, or an
explicit quality comparison. A small factual edit inside an approved deck
keeps its existing direction; it does not need a design contest.

## Before composition

Read the original material and define the audience's decision. Record the
questions a reader must be able to answer, including important qualifications,
periods, units, and category boundaries. Keep an answer key with source locators
outside the reviewer packet. Numerical provenance alone does not catch a missing
condition or a misleading relationship.

## Compare actual pages, not style names

Pick one or two representative pages that expose the difficult work: a dense
comparison, an explanatory diagram, or the primary evidence. Draft two materially
different compositions of the same content at the same reading size. Change the
reading path or carrier, not merely the palette. Render both; do not build two
whole decks. Preserve the trials separately from the deliverable.

Give the trials neutral identifiers and compare:

- Can the intended reader recover the claim and its qualifications?
- Does the visual make the relationship clearer than the supporting prose?
- Are the hierarchy, grouping, phrase endings, and labels usable at delivery size?
- Is the page actually well composed, rather than merely decipherable? Compare
  title-to-evidence scale, placement of visual weight, grouping, chart/legend
  integration, and source treatment. A reviewer who only repeats the page's
  facts has checked content, not visual craft.
- Does the subject have a recognizable presence? In a product pitch, can the
  reader see the product or a credible output rather than an interchangeable
  feature list? Judge the chosen treatment against accessible reference pages
  at the same viewing size, without importing another brand's claims or artwork.

Pick the stronger fit with a visible reason, or reject both. Neither diversity
nor a larger object inventory is a reason to win. A template or supplied brand
remains the authority where the request fixes it.

## Separate the reviewer from the maker

A reviewer receives only the audience/task, original source excerpts, unanswered
reader questions, and persisted page images. Do not include the script, author's
preferred candidate, rationale, self-scores, or prior critique.

When available and approved, use a fresh read-only model session. The bundled
`scripts/review-deck.mjs` uses Mixdog's pristine headless execution boundary:
no prior conversation or Memory, no delegation, and the standard read-only tool
policy. Provider and model must be explicit; it uses the existing sign-in, never
asks to paste credentials. This is context separation, not an OS filesystem
sandbox or proof that the model's judgement is unbiased.

Run from the Project; `<pptx-skill-directory>` is the `<base-dir>` the runtime
printed when the skill loaded (`SKILL.md` §2 step 9 carries the command with
that directory already resolved):

```text
node "<pptx-skill-directory>/scripts/review-deck.mjs" packet.json --provider <provider> --model <model> --output review.json
```

Packet format (all paths relative to the packet file unless absolute):

```json
{
  "task": "The audience and what they need to understand or decide",
  "sources": ["source-excerpt.md"],
  "questions": [{"id": "Q1", "question": "What period and unit do the figures use?"}],
  "candidates": [{"id": "C1", "pages": ["page-1.png", "page-2.png"]}]
}
```

Sources are text excerpts with original locators, not rewritten author arguments.
Keep complete relevant tables and caveats. The runner copies only these declared
inputs into a fresh packet directory and renames page files neutrally. It caps
the packet at 24 page images, 8 text sources, and 20 questions; split a larger
review into coherent sections while still checking the deck sequence separately.
The report records the route, input hashes, raw response, and validated decision.

Without a fresh reviewer, perform a separate source-and-image reading pass and
label it **self-review**, not independent review. A failed or incomplete review
is unavailable, never a pass. Preserve its report and fix the reported execution
failure; do not invent another model's approval.

## Apply the review

For each candidate, the reviewer answers the questions with page evidence and
reports page-specific keep/fix observations. Missing or ambiguous information is
explicit. The maker checks answers against the withheld source key and either
fixes an observed defect or records why the proposed change would harm fidelity.
Reviewer preference is advisory, not a numerical release gate.
Keep the content verdict separate from the design verdict. When the user rejects
the visual quality, that is new acceptance evidence: do not defend the page with
an earlier model pass. Use reference pages at the same viewing size to identify
specific craft differences, then redesign the affected structure rather than
rerunning the same review for another approval.

Use three distinct outcomes: mechanical integrity, visual craft, and user
acceptance. Automatic contrast, color, occupancy, and rhythm statistics are
diagnostics only; even a perfect score cannot approve the design. For each page,
write the visible strength and any material weakness before assigning the
required critique scores. Never infer visual quality from file validity or raise
scores to satisfy the gate. After deleting a failed visual, inspect the resulting
composition rather than treating fewer objects as a repair.

Expand the selected direction, then run this same source-and-image review on
the completed deck. Correct factual loss and material visual defects before
finalize. Re-review changed pages and dependent claims; do not rerun unchanged
checks just to obtain higher scores. Keep file validity and native editability
checks separate from visual preference. The author remains responsible for the
final per-page critique, reviewed token, and unresolved limitations.

For a skill evaluation, preserve the previous instructions and use the same
source, reader questions, and review protocol. Record the implicit positive,
edge, and close-negative cases. A guided trial is a smoke test, not a controlled
A/B result or a claim of frontier parity.
