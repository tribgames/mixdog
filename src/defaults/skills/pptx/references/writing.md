# Writing

Owns the words once the fact sheet exists (`SKILL.md` §2 step 2): how a sentence is built, how a number, a date, a sum of money, and a unit are written, and the room a translation needs. Always loaded; the notation rules are the same for a document or a sheet in the same package (the docx and xlsx skills point here). Rule strength as in `direction.md`.

## 1. Sentences
**Default — a title is a finding**: the assertion title (`direction.md` §2) states what the reader now believes, in one clause, no trailing period, no topic-colon ("시장 개요: 성장세" is a topic). Two lines at `TYPE.title` is the ceiling (`head()` throws past it); a title that needs three is two findings, or one with too many qualifiers.
**Default — one idea per line**: a body line carries one idea; a block on a balanced slide carries at most two sentences; the qualification goes to a caption or the notes (`composition.md` §8). Cut the connective that opens a line (그리고, 또한, 따라서) — the layout is the connective.
**Default — parallel items are parallel in form**: every item of a list is the same kind of phrase (all noun phrases, or all verb phrases ending the same way); a list whose items differ in kind is prose or a table. More than four numbers in a list is a table (`charts.md`).
**Default — one register per deck**: titles, takeaways, and body in the plain declarative (한다체: "야간 운영이 원인이다"); the ask and the closing may take the polite form (합니다체: "승인해 주십시오"); never both on one page. A Latin deck keeps one voice the same way (present tense, active voice).
**Default — emphasis is one run**: one load-bearing figure or noun per sentence lifted as a bold run in the accent (`emphasis()`), never a connective, every noun, or structural text.
**Default — the title and the body do not repeat each other**: the body adds the evidence, the mechanism, or the consequence; a body line that restates the title is cut.
**Hard rule — names and figures are the source's**: entity names, product names, figures, and abbreviations stay in their original form; an abbreviation is spelled out once at its first mention and then used alone. → runtime `number_without_fact` for figures; names → manual

## 2. Numbers
**Hard rule — one precision, one scale per series**: the values of one column, series, or stat band show the same number of decimals and the same unit scale (천 · 만 · 억 · %); a series that mixes `12.5` with `13`, or `4,200만` with `1.2억`, is rewritten to one. Show the precision the comparison needs (`composition.md` §6), disclose rounding in the caption, and keep the exact values in the native chart data or a reference table. → manual
- Thousands take a comma (`4,200`, `1,234,567`); a year never does (`2026`). Decimals take a point, never a comma.
- Percent sits against its number (`12.5%`); a change in percentage points says so (`3%p`); a multiple is `1.6배` (Korean) or `1.6×` (Latin), never `160%`.
- Korean counters follow the number without a space (`4,200건`, `31대`, `22시`); SI and Latin units take a space (`12 GB`, `3.2 km`, `250 ms`), except `%` and `°`.
- A range is an en dash with no spaces and the unit once at the end (`12–18%`, `2024–2026`, `22:00–01:00`); "부터/까지" is prose, not a range.
- A negative number in display uses the minus sign (`−4.2%`, U+2212) so it reads as a sign, not a hyphen; a cell in a sheet keeps `-` so it computes.
- Large Korean numbers scale to one unit per series (`1.2억`, `4,200만`), the unit on the axis or the header ("단위: 천 건") when every value shares it; a Latin deck uses `K` / `M` / `B` the same way.
- Money: `₩1,200,000` in a cell, `120만 원` in prose (a space before 원); one currency symbol per deck, never a symbol and the word together (`₩120만 원`); a foreign sum keeps its own symbol and the conversion date in the source line.
- Figures sit in the data face (`T.data` — the kit's `hero()`, `statBand()`, `gauge()`, and value labels do this); a figure inside prose stays in the prose face.

## 3. Dates and time
- Prose in a Korean deck: `2026년 9월 6일`, `9월 6일`, `2026년 9월`, `2026년 3분기`; `Q3` only when the source says it; `FY2026` only when the source runs a fiscal year.
- Axes, tables, file names, and anything sorted: ISO `2026-09-06`, `2026-09`; time in 24 hours (`22:00`); a period `2026-09-01 ~ 2026-09-30` in a cell, `9월 1일–30일` in prose.
- A relative word (지난 분기, 최근, 현재) carries its absolute date in the caption or the source line — a leave-behind is read weeks later.
- A Latin deck: `6 September 2026` in prose, `Sep 2026` on an axis, no ordinal suffixes, no numeric month-first dates.

## 4. Room for translation
**Default — leave 30% when the deck will travel**: Korean copy set in English runs about 30% wider (German 35%), so a Korean box measured to fit exactly breaks in the translation; a deck the brief says will be translated keeps a third of every text zone free (`fitSize` with a smaller `w`, or shorter copy), and its hero and badge widths are measured on the longer language. English into Korean is shorter, but Hangul wraps by the eojeol and the kit measures at 98% of the zone (`WRAP_MARGIN`), so a tight Latin box still needs a line's slack.
- Product names, entity names, and code identifiers are never translated; a transliteration appears only when the source uses it.
- A source figure keeps its unit and scale; convert only when the audience's convention differs, and say so in the source line.

## 5. Read-back
Before the fact check (`SKILL.md` §5): every title reads as a finding; every figure matches its fact line at the precision its peers show; one unit scale per series; one date notation per surface (prose, axis, table); one register; no line that restates the title; the first mention of every abbreviation spelled out.
