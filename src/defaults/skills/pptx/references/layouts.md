# Skeleton catalog

Owns the page skeletons the composition step (`design.md` §4) picks from, with starting geometry on the 13.33 × 7.5 canvas and the `device-kit.md` calls that draw them. Picture skeletons (P1-P18, E6) live in `pictures.md` and load only when the user supplied pictures.

**Reference — not a constraint**: entries are options; combine compatible ones or author a clearer free-form composition. Proportion follows information weight; the numbers are first placements. Ids are used in the brief's slide plan and by the variety rule (`design.md` §4.5).

Canvas: `W 13.33`, `H 7.5`, margin `M 0.6`; safe area x 0.6-12.73, y 0.6-6.9. Kicker at y 0.6, title at y 1.0 (0.1 in below the kicker); content field y 1.8-6.6; the page number sits on the master.

## 1. Statement skeletons (S) — focal claim
| Id | Skeleton | Starting geometry |
|---|---|---|
| S1 | Statement in air | one sentence 28-32 pt display face at box(M, 2.4, 9.5-11, 2.2), left aligned, one `emphasis` run in the accent; attribution 12-14 pt below; 40-60% of the canvas empty |
| S2 | Hero number | `hero()` 72-96 pt at (M, 2.2) width 5, label under it, explanation 18 pt at x 7.2 width 5.5; or centered at (W/2 - 3, 2.0) width 6 with one line under |
| S3 | Pull quote | 120 pt quotation mark in the accent at (M - 0.1, 1.3); quote 28-30 pt at (M + 0.9, 2.6) width 10-11; attribution 13 pt muted below |
| S4 | Receded picture, oversized type | see `pictures.md` (needs a picture) |
| S5 | Ghost numeral | `ghost()` 240 pt at (x 7.5, y 1.2) behind; the claim 28 pt at (M, 2.6) width 7. Chapter marks, dark-tech and editorial anchors |

## 2. Evidence skeletons (E) — chart, table, or number as the field
| Id | Skeleton | Starting geometry |
|---|---|---|
| E1 | Chart as spine + takeaway | `chart()` at box(M, 1.8, 8.0-8.4, 4.4) with `accent` on the category the claim is about; one `hero()` or a 3-line note at x 9.4 width 3.3; `takeaway()` at y 6.2. The chart is the largest element |
| E2 | Chart with side rail | `chart()` at box(M, 1.8, 7.6, 4.8); `field()` rail at x 8.6 width 4.1 with a bold lead and 2-3 bullets or one mini-table. The rail explains the chart; it is not a card |
| E3 | Small multiples | `smallMultiples()` at box(M, 2.4, W - 2M, 3.8), 3-4 panels, shared `max`, one label above each, one comparison sentence under at y 6.4. "Same shape, different size" |
| E4 | Stat band | 3-5 `hero()` blocks on one baseline y 2.4 (x = M + i·step), `hairline` at y 4.25 spanning the row, one line of context 13-16 pt under each. Numbers 54-60 pt; never boxed |
| E5 | Table with verdict | `addTable` at box(M, 1.8, W - 2M, 4.4); header row accent; alternate rows paperAlt; verdict column bold + accent tint, never color-only; source line 11 pt at y 6.5 |
| E7 | Gauge / share | `gauge()` r 1.6 at the left third; meaning at the right in 18 pt with one `emphasis` run. Single proportion only; two or more become E3 or E4 |
| E8 | Specimen | the subject drawn (`design.md` §4.0): `specimen()` rows at box(M, top, 7.6-8, …) — a weight ladder, a size ramp, a pairing sample, or swatches through `field()` — with labels in the left 1.6 in; the claim as prose at x 9.0 width 3.7, or one line under the rows. The specimen is the largest element; nothing describes what it shows |

## 3. Relationship skeletons (R) — order, link, parent, membership, contrast, overlap
| Id | Skeleton | Starting geometry |
|---|---|---|
| R1 | Chevron run | `chevrons()` at box(M, 2.0, W - 2M, 1.15), 3-6 stages, active stage in the accent; number 28 pt and detail 12.5-13 pt under each stage; adjacent columns keep 0.3 in. Straight, level order |
| R2 | Timeline | `hairline` across y 3.9; `node()` d 0.55 at content-driven x (uneven dates stay uneven); titles 15 pt bold under, details 12 pt; an accent node for the present |
| R3 | Stepped process | `steps()` — 3-5 blocks rising or falling diagonally, block i at (M + i·2.45, 5.3 - i·0.85), w 2.2, h 1.3; connectors edge to edge |
| R4 | Switchback path | two or three rows of `S.rightArrow` / `S.leftArrow` runs on baselines y 2.2, 3.9, 5.6 with `S.downArrow` turns; stops as `S.roundRect` on the runs. Long order that must wrap |
| R5 | Cycle | `cycle()` — 3-6 block-arc segments around (W/2, 4.25), r 1.85-2.2, thickness 0.28, 6° gaps, labels outside at the mid-angle, a paper disc in the middle for a center label. One indivisible loop is `S.circularArrow` |
| R6 | Hub and spokes | hub ellipse d 1.9 at (W/2 + 0.2, 4.5); satellites d 1.2 on radius 2.2 at content-driven angles; `connector()` from satellite edge to hub edge; notes beside satellites, left-aligned on the right side, right-aligned on the left |
| R7 | Split / merge | sources as `S.roundRect` in a left column (x M, w 2.8, h 0.9, gap 0.3), one target at x 8.5 vertically centered; connectors converge on the target's left edge. Reverse for a split |
| R8 | Feedback loop | R1 or R3 plus one dashed `connector()` returning from the last stage's top edge to the first along y 1.5 (up, across, down) |
| R9 | Tree / indent | root at (M, 1.9) width 4, children indented 0.5 per level with `brace()` spanning each parent's children; or radiating: root ellipse at center, children on a ring, grandchildren on a second ring |
| R10 | Swimlanes | 2-4 lane `field()` rows sharing seams (y 1.8 + i·laneH, laneH = 4.8 / n), lane labels 14 pt bold in a 1.6 in left column; units as `S.roundRect` inside their lane with 0.15 margin; phase boundaries as `connector(arrow:'none')` crossing all lanes |
| R11 | Brace groups | 2-3 groups of items in one column, each spanned by a `brace()` on the left and named at the brace's tip; no boxes |
| R12 | Two planes | two `field()` planes on one baseline (x M and W/2 + 0.15, w W/2 - M - 0.15, y 1.9, h 3.5-4.8), matched labels at the top, 0.3 in between; one difference marker (`lift()` or accent tint) on one side only; a `takeaway()` closes the page when the planes end above y 5.5 |
| R13 | 2×2 field | one `field()` at box(M, 1.8, W - 2M, 4.8) with one vertical and one horizontal `hairline` crossing at the semantic threshold (not the center); axis labels 12 pt at the ends; items placed by their values |
| R14 | Tiered stack | `tiers()` — 3-4 trapezoid tiers on one shared taper, widths monotonic, labels inside; or `S.triangle` plus hairline dividers when tiers are one duty |
| R15 | Overlapping sets | `sets()` — 2-3 ellipses d 3.0 overlapping 1.0-1.2, `transparency: 65`, owner labels outside, the shared meaning in the common region |

## 4. Anchors
**Default — (may override when the family's preset says otherwise)**:
| Slide | Composition |
|---|---|
| Cover | P1, P5, or S5 on a dark or gradient field; kicker at (M, 2.15), title 44 pt at (M, 2.55) width 8.2, subtitle 18 pt at (M, 4.85), meta 12 pt at (M, H - 1.0); the motif at full size on the right third |
| Section | the cover reduced: motif at half size, section number as an S5 ghost numeral or a 72 pt numeral, section title 36 pt |
| Closing | statement 36 pt at (M, 2.3) width 9; the ask 18 pt in the accent at y 4.5-5.0; contact/meta 12 pt at (M, H - 1.0); the cover motif repeated smaller |
