//! The running turn's spinner as Node's TUI store sets it when a turn begins (	urn.mjs `runTurn`: `busy: true` and a spinner
//! whose verb is `pickVerb(turn.index)`, `labels.mjs:7-9`, over the shared pool, `spinner-verbs.mjs`; `turn.index` is the
//! session's completed turns, `beginTurn`'s `getState().stats.turns`).

use serde_json::Value;
use serde_json::json;

/// `spinner-verbs.mjs` `SPINNER_VERBS`, in order.
const SPINNER_VERBS: [&str; 187] = [
    "Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming", "Beboppin'", "Befuddling", "Billowing", "Blanching",
    "Bloviating", "Boogieing", "Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bunning", "Burrowing", "Calculating", "Canoodling",
    "Caramelizing", "Cascading", "Catapulting", "Cerebrating", "Channeling", "Channelling", "Choreographing", "Churning", "Clauding",
    "Coalescing", "Cogitating", "Combobulating", "Composing", "Computing", "Concocting", "Considering", "Contemplating", "Cooking",
    "Crafting", "Creating", "Crunching", "Crystallizing", "Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
    "Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting", "Envisioning",
    "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling", "Flambéing", "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering",
    "Forging", "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping", "Garnishing", "Generating", "Gesticulating", "Germinating",
    "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding", "Honking", "Hullaballooing", "Hyperspacing",
    "Ideating", "Imagining", "Improvising", "Incubating", "Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning", "Kneading",
    "Leavening", "Levitating", "Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing", "Misting", "Moonwalking",
    "Moseying", "Mulling", "Mustering", "Musing", "Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating", "Orbiting",
    "Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing", "Philosophising", "Photosynthesizing", "Pollinating",
    "Pondering", "Pontificating", "Pouncing", "Precipitating", "Prestidigitating", "Processing", "Proofing", "Propagating", "Puttering",
    "Puzzling", "Quantumizing", "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting", "Ruminating", "Sautéing",
    "Scampering", "Schlepping", "Scurrying", "Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling", "Sketching",
    "Slithering", "Smooshing", "Sock-hopping", "Spelunking", "Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling", "Swooping",
    "Symbioting", "Synthesizing", "Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring",
    "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing", "Waddling", "Wandering", "Warping", "Whatchamacalliting",
    "Whirlpooling", "Whirring", "Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
];

/// `labels.mjs` `pickVerb(turn)`.
pub(crate) fn pick_verb(turn: u64) -> &'static str {
    SPINNER_VERBS[((turn * 7 + 3) % SPINNER_VERBS.len() as u64) as usize]
}

/// The spinner `runTurn` sets as the turn begins: requesting, nothing received yet.
pub(crate) fn started(turn: u64, started_at: i64) -> Value {
    json!({
        "active": true,
        "verb": pick_verb(turn),
        "startedAt": started_at,
        "responseLength": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "mode": "requesting",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `pickVerb(0)` is the pool's fourth verb (Node's recorded first turn shows `Architecting`); the index wraps over the pool.
    #[test]
    fn verbs_are_picked_as_node_picks_them() {
        assert_eq!(pick_verb(0), "Architecting");
        assert_eq!(pick_verb(1), SPINNER_VERBS[10]);
        assert_eq!(pick_verb(187), "Architecting");
    }
}