// BRIEF
// subject/audience/action: The night-delivery pilot — city transport board members vote to extend it to every district
// reading mode: text · argument mode: narrative
// directions: A editorial, hue 30 warm paper, serif, rail — Economist-style article deck with a left rail and hairlines · B swiss-minimal, hue 220, weight, bare — grid-locked, one oversized plane · selected: A · why: the board reads it before the meeting like an article; serif display and a rail give it that register
// style: editorial · palette: hue 30 · accent hue 355 · accent: C8102E · type: MODE text → body 13pt · script: latin · pairing: serif · fonts: noto
// motif: hairline rules and a drop numeral · rhythm: anchor, dense, dense, breathing, dense, dense, anchor
// facts: sample — an illustrative pilot; every figure is an example
// slide plan: 1 job: cover · relationship: none · move: the reader knows the pilot changed daytime traffic · composition: display headline on open paper, dateline, one hairline · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: claim · relationship: focal claim · move: congestion fell and complaints did not rise · composition: display claim left, stat band under it · carriers: statement · texture: keywords · rhythm: dense
//   3 job: evidence · relationship: evidence · move: the fall held for six weeks · composition: line chart on the main column, legend and reading in the rail · carriers: chart, prose · texture: prose · rhythm: dense
//   4 job: quote · relationship: evidence · move: the drivers felt it · composition: pull quote across the column with attribution · carriers: quote · texture: prose · rhythm: breathing
//   5 job: comparison · relationship: contrast · move: day and night deliveries compared · composition: dumbbell of five districts, reading under · carriers: diagram, prose · texture: prose · rhythm: dense
//   6 job: process · relationship: order · move: the rollout has four steps · composition: steps across the body, reading under · carriers: diagram, prose · texture: list · rhythm: dense
//   7 job: closing · relationship: none · move: the board votes · composition: the ask as a display line on paper with contact · carriers: statement · texture: keywords · rhythm: anchor

deck({ style: 'editorial', hue: 30, accentHue: 355, mode: 'text', script: 'latin', pairing: 'serif', fonts: 'noto' });

// 1 cover
{
  const s = quiet();
  display(s, 'When the night changed, the day moved', { kicker: 'CITY LOGISTICS BRIEF', emph: 'the day moved', line: 'A report on the first six weeks of the night-delivery pilot, for the transport board.' });
  dateline(s, 'September 2026');
}

// 2 claim
{
  const s = light();
  const b = display(s, 'Congestion fell six points; complaints did not rise', { kicker: 'SUMMARY', emph: 'did not rise' });
  statBand(s, M, b + GAP.between * 1.5, Z.body.x + Z.body.w - M, [
    { value: '−6', unit: 'pts', label: 'daytime congestion index' },
    { value: '+2', unit: '', label: 'deliveries per van per day' },
    { value: '0', unit: '', label: 'added noise complaints' },
  ]);
  source(s, 'Source: city traffic office, pilot weeks 1–6 (illustrative figures)');
}

// 3 line chart + rail reading
{
  const s = light();
  const top = head(s, 'EVIDENCE', 'The fall held for all six weeks, in every pilot district');
  const seam = splitAt(Z.body.x, Z.body.w, 7, 3);
  chart(s, seam.left.x, top, seam.left.w, avail(top), { type: 'line', labels: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'], accent: 0, series: [{ name: 'Pilot districts', values: [71, 68, 66, 65, 65, 64] }, { name: 'Other districts', values: [70, 70, 71, 70, 71, 70] }] });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: 'Pilot districts', text: 'The index fell from 71 to 64 and did not bounce back after the first fortnight.' },
    { label: 'Other districts', text: 'Unchanged at about 70, which rules out a citywide seasonal dip.' },
  ]);
  source(s, 'Congestion index, weekday 07:00–19:00 average. Source: city traffic office (illustrative)');
}

// 4 quote
{
  const s = light();
  const top = head(s, 'VOICES', 'Drivers noticed first');
  quote(s, Z.body.x, top + 0.3, Z.body.w, 'At night the route takes me an hour. The same run in the afternoon took three.', 'Delivery driver, Riverside district');
}

// 5 dumbbell
{
  const s = light();
  const top = head(s, 'COMPARISON', 'Night runs were faster in every district we measured');
  const b = dumbbell(s, Z.body.x, top, Z.body.w, [
    { label: 'Riverside', a: 58, b: 31 },
    { label: 'Old Town', a: 64, b: 35 },
    { label: 'Harbour', a: 49, b: 29 },
    { label: 'University', a: 52, b: 33 },
    { label: 'Market Hill', a: 61, b: 34 },
  ], { rowH: 0.6, format: (v) => `${v} min` });
  reading(s, Z.body.x, b + GAP.between, Z.body.w, ['Grey dot: the day run. Red dot: the same route at night. The night run saved 20 to 29 minutes on a 20-drop route.']);
  source(s, 'Median minutes per 20-drop route, pilot weeks 1–6 (illustrative)');
}

// 6 steps
{
  const s = light();
  const top = head(s, 'ROLLOUT', 'Four steps take the pilot citywide by spring');
  await steps(s, Z.body.x, top, Z.body.w, avail(top), [
    { label: 'Certify vans', detail: 'Publish the low-noise standard and certify the fleet' },
    { label: 'Add districts', detail: 'Extend to the twelve districts that asked to join' },
    { label: 'Measure noise', detail: 'Post quarterly readings on the city site' },
    { label: 'Review', detail: 'Board review of the full year in March 2027', active: true },
  ]);
  source(s, 'Timeline as proposed in September 2026');
}

// 7 closing
{
  const s = quiet();
  display(s, 'We ask the board to extend the pilot to every district', { kicker: 'THE DECISION', emph: 'every district', line: 'logistics@city.example · City Logistics Office' });
}

await pres.writeFile({ fileName: OUTPUT });
