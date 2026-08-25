/**
 * src/tui/spinner-verbs.mjs — playful "thinking" verbs for the spinner.
 *
 * Playful spinner verbs. Shown as `<Verb>… (Ns · ↑ N tokens)` while a turn runs.
 *
 * ONE common pool, never a per-mode pool: the stream flips
 * thinking → tool-use → responding many times inside a single turn, so a
 * mode-keyed phrase rewrites itself every few seconds and reads as flicker.
 * The phrase is drawn from this list and held for a fixed window instead.
 */
export const SPINNER_VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming',
  "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing',
  'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing',
  'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting',
  'Cerebrating', 'Channeling', 'Channelling', 'Choreographing', 'Churning',
  'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing',
  'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating',
  'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating',
  'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling',
  'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting',
  'Envisioning', 'Evaporating', 'Fermenting', 'Fiddle-faddling', 'Finagling',
  'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering',
  'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping',
  'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying',
  'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking',
  'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising',
  'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning',
  'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating',
  'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling',
  'Mustering', 'Musing', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling',
  'Nucleating', 'Orbiting', 'Orchestrating', 'Osmosing', 'Perambulating',
  'Percolating', 'Perusing', 'Philosophising', 'Photosynthesizing', 'Pollinating',
  'Pondering', 'Pontificating', 'Pouncing', 'Precipitating', 'Prestidigitating',
  'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling', 'Quantumizing',
  'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting',
  'Ruminating', 'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning',
  'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering',
  'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting', 'Stewing',
  'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering',
  'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying',
  'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling',
  'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting',
  'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling',
  'Zesting', 'Zigzagging',
];

/** How long one phrase holds before the pool advances. */
export const SPINNER_VERB_ROTATE_MS = 30_000;

/** Odds that a 30s boundary actually swaps the phrase (user: 바꿀지 말지만
 *  랜덤 돌리면 되잖아). Below 1 the window stretches: ~half the boundaries
 *  hold, so a phrase lives 30s, 60s, 90s… and the rhythm stops being a
 *  metronome. */
export const SPINNER_VERB_CHANGE_ODDS = 0.5;

/**
 * Deterministic coin for ONE (turn, boundary) pair.
 *
 * Math.random() is not an option here: spinnerVerbFor runs on every render
 * tick (~1/s) and the TUI and the desktop each call it for themselves, so a
 * real RNG would reroll the word every second AND let the two surfaces
 * disagree. An integer hash keeps each boundary's answer fixed forever while
 * making the SEQUENCE of answers unpredictable — which is the part that reads
 * as random.
 */
function boundarySwaps(anchor, boundary) {
  let h = (Math.floor(anchor / 1000) + Math.imul(boundary, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 0x100000000 < SPINNER_VERB_CHANGE_ODDS;
}

/** Past this many boundaries (~34h) every boundary simply swaps; the walk is
 *  re-counted each render and must not grow without bound. */
const MAX_COUNTED_BOUNDARIES = 4096;

/** A coin streak can hold a phrase for a very long time (measured: up to 9
 *  minutes over 300 turns). After this many consecutive holds the next
 *  boundary swaps regardless of its coin, capping one phrase at 4 windows
 *  (~2 min) while leaving the 30/60/90/120s variety intact. */
const MAX_HELD_BOUNDARIES = 3;

/**
 * Modes that describe a STATE rather than ongoing work: they replace the pool
 * phrase for as long as the mode lasts, then the rotation resumes. Everything
 * else (requesting/thinking/tool-use/tool-input/responding) shares the pool.
 * `reconnecting` is absent on purpose — the engine authors that text itself
 * (retry countdown), so the surfaces pass `spinner.verb` through unchanged.
 */
export const SPINNER_MODE_OVERRIDE_VERBS = {
  compacting: 'Compacting conversation',
  'auto-clear': 'Auto-clearing conversation',
  resuming: 'Resuming conversation',
  'task-wait': '작업 대기 중',
};

/**
 * The phrase for a turn at a point in time. Derived from the turn's
 * `startedAt` so the TUI and the desktop show the SAME word at the same
 * second, and so mode flips cannot change it — only a 30s boundary can, and
 * only when that boundary's coin says so.
 */
export function spinnerVerbFor(startedAt = 0, now = 0, pool = SPINNER_VERBS) {
  const list = Array.isArray(pool) && pool.length ? pool : SPINNER_VERBS;
  const anchor = Math.max(0, Number(startedAt) || 0);
  const elapsed = anchor > 0 ? Math.max(0, (Number(now) || 0) - anchor) : 0;
  const boundaries = Math.floor(elapsed / SPINNER_VERB_ROTATE_MS);
  // Only the boundaries that FIRED advance the pool; a held boundary leaves
  // the phrase exactly where it was, which is what stretches the window.
  const counted = Math.min(boundaries, MAX_COUNTED_BOUNDARIES);
  let swaps = boundaries - counted;
  let held = 0;
  for (let boundary = 1; boundary <= counted; boundary += 1) {
    if (held >= MAX_HELD_BOUNDARIES || boundarySwaps(anchor, boundary)) {
      swaps += 1;
      held = 0;
    } else {
      held += 1;
    }
  }
  const seed = Math.floor(anchor / 1000) + swaps;
  return list[((seed * 7) + 3) % list.length];
}

/** Spinner glyph frames. */
export const SPINNER_FRAMES = ['◇', '◆', '◈', '◆', '◇'];
