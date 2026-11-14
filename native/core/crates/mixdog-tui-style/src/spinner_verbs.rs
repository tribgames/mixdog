//! The spinner phrases (`src/tui/spinner-verbs.mjs`): one common pool, never one per mode, because the stream flips
//! thinking, tool use and responding many times inside a turn and a mode-keyed phrase would rewrite itself every few
//! seconds. The phrase is drawn from the pool and held for a window; a few modes that describe a state (compacting,
//! resuming ...) replace it for as long as they last.
//!
//! The choice is a function of the turn start and the clock only, so the terminal UI and the desktop show the same word at
//! the same second, and no random source is needed: a hash of the turn start and the boundary index plays the coin.

/// The verb pool, in order.
pub const SPINNER_VERBS: [&str; 187] = [
    "Accomplishing",
    "Actioning",
    "Actualizing",
    "Architecting",
    "Baking",
    "Beaming",
    "Beboppin'",
    "Befuddling",
    "Billowing",
    "Blanching",
    "Bloviating",
    "Boogieing",
    "Boondoggling",
    "Booping",
    "Bootstrapping",
    "Brewing",
    "Bunning",
    "Burrowing",
    "Calculating",
    "Canoodling",
    "Caramelizing",
    "Cascading",
    "Catapulting",
    "Cerebrating",
    "Channeling",
    "Channelling",
    "Choreographing",
    "Churning",
    "Clauding",
    "Coalescing",
    "Cogitating",
    "Combobulating",
    "Composing",
    "Computing",
    "Concocting",
    "Considering",
    "Contemplating",
    "Cooking",
    "Crafting",
    "Creating",
    "Crunching",
    "Crystallizing",
    "Cultivating",
    "Deciphering",
    "Deliberating",
    "Determining",
    "Dilly-dallying",
    "Discombobulating",
    "Doing",
    "Doodling",
    "Drizzling",
    "Ebbing",
    "Effecting",
    "Elucidating",
    "Embellishing",
    "Enchanting",
    "Envisioning",
    "Evaporating",
    "Fermenting",
    "Fiddle-faddling",
    "Finagling",
    "Flamb\u{e9}ing",
    "Flibbertigibbeting",
    "Flowing",
    "Flummoxing",
    "Fluttering",
    "Forging",
    "Forming",
    "Frolicking",
    "Frosting",
    "Gallivanting",
    "Galloping",
    "Garnishing",
    "Generating",
    "Gesticulating",
    "Germinating",
    "Gitifying",
    "Grooving",
    "Gusting",
    "Harmonizing",
    "Hashing",
    "Hatching",
    "Herding",
    "Honking",
    "Hullaballooing",
    "Hyperspacing",
    "Ideating",
    "Imagining",
    "Improvising",
    "Incubating",
    "Inferring",
    "Infusing",
    "Ionizing",
    "Jitterbugging",
    "Julienning",
    "Kneading",
    "Leavening",
    "Levitating",
    "Lollygagging",
    "Manifesting",
    "Marinating",
    "Meandering",
    "Metamorphosing",
    "Misting",
    "Moonwalking",
    "Moseying",
    "Mulling",
    "Mustering",
    "Musing",
    "Nebulizing",
    "Nesting",
    "Newspapering",
    "Noodling",
    "Nucleating",
    "Orbiting",
    "Orchestrating",
    "Osmosing",
    "Perambulating",
    "Percolating",
    "Perusing",
    "Philosophising",
    "Photosynthesizing",
    "Pollinating",
    "Pondering",
    "Pontificating",
    "Pouncing",
    "Precipitating",
    "Prestidigitating",
    "Processing",
    "Proofing",
    "Propagating",
    "Puttering",
    "Puzzling",
    "Quantumizing",
    "Razzle-dazzling",
    "Razzmatazzing",
    "Recombobulating",
    "Reticulating",
    "Roosting",
    "Ruminating",
    "Saut\u{e9}ing",
    "Scampering",
    "Schlepping",
    "Scurrying",
    "Seasoning",
    "Shenaniganing",
    "Shimmying",
    "Simmering",
    "Skedaddling",
    "Sketching",
    "Slithering",
    "Smooshing",
    "Sock-hopping",
    "Spelunking",
    "Spinning",
    "Sprouting",
    "Stewing",
    "Sublimating",
    "Swirling",
    "Swooping",
    "Symbioting",
    "Synthesizing",
    "Tempering",
    "Thinking",
    "Thundering",
    "Tinkering",
    "Tomfoolering",
    "Topsy-turvying",
    "Transfiguring",
    "Transmuting",
    "Twisting",
    "Undulating",
    "Unfurling",
    "Unravelling",
    "Vibing",
    "Waddling",
    "Wandering",
    "Warping",
    "Whatchamacalliting",
    "Whirlpooling",
    "Whirring",
    "Whisking",
    "Wibbling",
    "Working",
    "Wrangling",
    "Zesting",
    "Zigzagging",
];

/// Spinner glyph frames.
pub const SPINNER_FRAMES: [&str; 5] = ["\u{25c7}", "\u{25c6}", "\u{25c8}", "\u{25c6}", "\u{25c7}"];

/// Modes that describe a state rather than ongoing work, with the phrase that replaces the pool phrase while the mode
/// lasts. `reconnecting` is absent on purpose: the engine authors that text itself (the retry countdown).
pub const SPINNER_MODE_OVERRIDE_VERBS: [(&str, &str); 5] = [
    ("compacting", "Compacting conversation"),
    ("auto-clear", "Auto-clearing conversation"),
    ("resuming", "Resuming conversation"),
    ("task-wait", "\u{c791}\u{c5c5} \u{b300}\u{ae30} \u{c911}"),
    ("model-thinking", "Model thinking"),
];

/// How long one phrase holds before the pool advances, in milliseconds.
const ROTATE_MS: f64 = 30_000.0;

/// Odds that a 30 s boundary swaps the phrase. Below 1 the window stretches (about half the boundaries hold), so a
/// phrase lives 30 s, 60 s, 90 s ... and the rhythm is not a metronome.
const CHANGE_ODDS: f64 = 0.5;

/// Past this many boundaries (about 34 h) every boundary swaps: the walk is re-counted on each render and must not
/// grow without bound.
const MAX_COUNTED_BOUNDARIES: f64 = 4096.0;

/// A coin streak could hold a phrase for minutes; after this many consecutive holds the next boundary swaps whatever
/// its coin says, which caps one phrase at four windows (about two minutes).
const MAX_HELD_BOUNDARIES: u32 = 3;

/// `ToInt32` of a number, as `| 0` applies it.
fn to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    value.trunc().rem_euclid(4_294_967_296.0) as u32 as i32
}

/// The deterministic coin for one (turn, boundary) pair: an integer hash keeps each boundary's answer fixed forever
/// while the sequence of answers stays unpredictable. `Math.random()` would reroll the word on every render and let
/// the two surfaces disagree.
fn boundary_swaps(anchor: f64, boundary: u32) -> bool {
    let imul = |a: i32, b: i32| a.wrapping_mul(b);
    let mut h = to_int32((anchor / 1000.0).floor() + f64::from(imul(boundary as i32, 0x9e37_79b1_u32 as i32)));
    h = imul(h ^ ((h as u32) >> 16) as i32, 0x21f0_aaad);
    h = imul(h ^ ((h as u32) >> 15) as i32, 0x735a_2d97);
    let hashed = (h ^ ((h as u32) >> 15) as i32) as u32;
    f64::from(hashed) / 4_294_967_296.0 < CHANGE_ODDS
}

/// The index into a pool of `len` phrases for a turn that started at `started_at` (milliseconds since the epoch,
/// 0 when unknown) at time `now`: derived from the start so both surfaces say the same word at the same second, and
/// held until a boundary's coin says swap. Only boundaries that fired advance the pool.
fn verb_index(started_at: f64, now: f64, len: usize) -> usize {
    let number = |value: f64| if value.is_nan() { 0.0 } else { value };
    let anchor = number(started_at).max(0.0);
    let elapsed = if anchor > 0.0 { (number(now) - anchor).max(0.0) } else { 0.0 };
    let boundaries = (elapsed / ROTATE_MS).floor();
    let counted = boundaries.min(MAX_COUNTED_BOUNDARIES);
    let mut swaps = boundaries - counted;
    let mut held = 0;
    for boundary in 1..=counted as u32 {
        if held >= MAX_HELD_BOUNDARIES || boundary_swaps(anchor, boundary) {
            swaps += 1.0;
            held = 0;
        } else {
            held += 1;
        }
    }
    let seed = (anchor / 1000.0).floor() + swaps;
    ((seed * 7.0 + 3.0) % len as f64) as usize
}

/// `spinnerVerbFor(startedAt, now)`: the phrase of the common pool for a turn at a point in time.
pub fn spinner_verb_for(started_at: f64, now: f64) -> &'static str {
    SPINNER_VERBS[verb_index(started_at, now, SPINNER_VERBS.len())]
}

/// `spinnerVerbFor(startedAt, now, pool)`: the phrase of a caller's pool; an empty pool is the common one.
pub fn spinner_verb_in<S: AsRef<str>>(started_at: f64, now: f64, pool: &[S]) -> String {
    if pool.is_empty() {
        return spinner_verb_for(started_at, now).to_owned();
    }
    pool[verb_index(started_at, now, pool.len())].as_ref().to_owned()
}

/// The phrase that replaces the pool phrase while a state mode lasts (`SPINNER_MODE_OVERRIDE_VERBS[mode]`).
pub fn mode_override_verb(mode: &str) -> Option<&'static str> {
    SPINNER_MODE_OVERRIDE_VERBS.iter().find(|(name, _)| *name == mode).map(|(_, verb)| *verb)
}
