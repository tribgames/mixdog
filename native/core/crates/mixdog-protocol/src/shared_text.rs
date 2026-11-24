//! `SharedText`: a text held once by every holder of it.

use serde::Deserialize;
use serde::Serialize;

/// A text held once by everything that holds it: a copy is a count, and two fields with the same text (a tool row's `result`
/// and `rawResult`) are one allocation. It reads and writes as the string it is. Made from a `String`, it is that string,
/// moved.
///
/// A text of [`SHARED_MIN`] bytes or more is one allocation for the whole process while anything holds it: whoever makes it
/// again (a row decoded from the log, the same row read into the model context, the message a provider is sent) is given the
/// allocation already held. The table that finds it holds no text alive: its entry goes with the text's last holder.
#[derive(Clone)]
pub struct SharedText(std::sync::Arc<Text>);

struct Text {
    /// The hash of the bytes of a text the table knows; 0 for a shorter one.
    key: u64,
    text: String,
}

/// The shortest text the process holds once. Shorter ones are their own allocation: a table entry and a hash would cost
/// more than the copy.
pub const SHARED_MIN: usize = 256;

/// The keys are hashes already.
#[derive(Default)]
struct Keyed(u64);

impl std::hash::Hasher for Keyed {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, _: &[u8]) {}
    fn write_u64(&mut self, key: u64) {
        self.0 = key;
    }
}

type Known = std::collections::HashMap<u64, std::sync::Weak<Text>, std::hash::BuildHasherDefault<Keyed>>;

/// The texts of [`SHARED_MIN`] bytes or more held now, by the hash of their bytes. Its lock is held for a lookup, an
/// insertion or a removal of one entry: no text is hashed, compared, copied or freed under it.
static KNOWN: std::sync::Mutex<Option<Known>> = std::sync::Mutex::new(None);

fn known<R>(f: impl FnOnce(&mut Known) -> R) -> R {
    f(KNOWN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_or_insert_with(Known::default))
}

fn key_of(text: &str) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::hash::DefaultHasher::new();
    hasher.write(text.as_bytes());
    hasher.finish()
}

static EMPTY: std::sync::LazyLock<std::sync::Arc<Text>> = std::sync::LazyLock::new(|| std::sync::Arc::new(Text { key: 0, text: String::new() }));

/// The allocation of `text` every holder shares: the one held now, else its own, which is the string itself when it was
/// given one.
fn held(text: std::borrow::Cow<'_, str>) -> std::sync::Arc<Text> {
    if text.len() < SHARED_MIN {
        return std::sync::Arc::new(Text { key: 0, text: text.into_owned() });
    }
    let key = key_of(&text);
    if let Some(held) = known(|known| known.get(&key).and_then(std::sync::Weak::upgrade)) {
        // Another text under the same hash is held apart.
        return if held.text == *text { held } else { std::sync::Arc::new(Text { key, text: text.into_owned() }) };
    }
    let own = std::sync::Arc::new(Text { key, text: text.into_owned() });
    // One made between the lookup and here is the one held: this one is then let go (its own removal leaves that entry).
    let other = known(|known| match known.get(&key).and_then(std::sync::Weak::upgrade) {
        Some(held) => Some(held),
        None => {
            known.insert(key, std::sync::Arc::downgrade(&own));
            None
        }
    });
    match other {
        Some(held) if held.text == own.text => held,
        _ => own,
    }
}

impl Drop for SharedText {
    fn drop(&mut self) {
        if self.0.text.len() < SHARED_MIN {
            return;
        }
        // The holder lets go first and looks afterwards: of two last holders letting go at once, the later one finds no
        // holder left, so the entry leaves under every interleaving. A text made again in between has an entry of its
        // own, which is not this one's and stays.
        let held = std::mem::replace(&mut self.0, EMPTY.clone());
        let (key, entry) = (held.key, std::sync::Arc::downgrade(&held));
        drop(held);
        if entry.strong_count() == 0 {
            known(|known| {
                if known.get(&key).is_some_and(|known| known.ptr_eq(&entry)) {
                    known.remove(&key);
                }
            });
        }
    }
}

impl SharedText {
    pub fn as_str(&self) -> &str {
        &self.0.text
    }

    /// Whether the two are one allocation.
    pub fn shares(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl PartialEq for SharedText {
    fn eq(&self, other: &Self) -> bool {
        self.shares(other) || self.0.text == other.0.text
    }
}

impl Eq for SharedText {}

impl std::hash::Hash for SharedText {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.0.text.as_str().hash(state);
    }
}

impl Default for SharedText {
    fn default() -> Self {
        Self(EMPTY.clone())
    }
}

impl std::ops::Deref for SharedText {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0.text
    }
}

impl AsRef<str> for SharedText {
    fn as_ref(&self) -> &str {
        &self.0.text
    }
}

impl std::borrow::Borrow<str> for SharedText {
    fn borrow(&self) -> &str {
        &self.0.text
    }
}

impl std::fmt::Debug for SharedText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(self.0.text.as_str(), f)
    }
}

impl std::fmt::Display for SharedText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.text)
    }
}

impl From<String> for SharedText {
    fn from(text: String) -> Self {
        Self(held(text.into()))
    }
}

impl From<&str> for SharedText {
    fn from(text: &str) -> Self {
        Self(held(text.into()))
    }
}

impl From<&String> for SharedText {
    fn from(text: &String) -> Self {
        Self::from(text.as_str())
    }
}

impl From<SharedText> for String {
    fn from(text: SharedText) -> Self {
        text.0.text.clone()
    }
}

impl PartialEq<str> for SharedText {
    fn eq(&self, other: &str) -> bool {
        self.0.text == other
    }
}

impl PartialEq<&str> for SharedText {
    fn eq(&self, other: &&str) -> bool {
        self.0.text == *other
    }
}

impl PartialEq<String> for SharedText {
    fn eq(&self, other: &String) -> bool {
        self.0.text == *other
    }
}

impl PartialEq<SharedText> for String {
    fn eq(&self, other: &SharedText) -> bool {
        *self == other.0.text
    }
}

impl PartialEq<SharedText> for str {
    fn eq(&self, other: &SharedText) -> bool {
        self == other.0.text
    }
}

impl PartialEq<SharedText> for &str {
    fn eq(&self, other: &SharedText) -> bool {
        *self == other.0.text
    }
}

impl Serialize for SharedText {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.text)
    }
}

thread_local! {
    /// The last two short texts decoded on this thread, while something still holds them: a tool row states its result up
    /// to three times (`output`, `run.result`, `run.rawResult`), one after the other in its encoding.
    static DECODED: std::cell::RefCell<[std::sync::Weak<Text>; 2]> = const { std::cell::RefCell::new([std::sync::Weak::new(), std::sync::Weak::new()]) };
}

impl SharedText {
    /// A text read from an encoding: the allocation every holder of it shares, and for a short one that of an equal text
    /// decoded just before it on this thread, else its own.
    pub fn decoded(text: &str) -> Self {
        if text.len() >= SHARED_MIN {
            return Self::from(text);
        }
        DECODED.with(|decoded| {
            let mut decoded = decoded.borrow_mut();
            if let Some(held) = decoded.iter().filter_map(std::sync::Weak::upgrade).find(|held| held.text == text) {
                return Self(held);
            }
            let own = std::sync::Arc::new(Text { key: 0, text: text.to_owned() });
            decoded.swap(0, 1);
            decoded[0] = std::sync::Arc::downgrade(&own);
            Self(own)
        })
    }
}

impl<'de> Deserialize<'de> for SharedText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Text;

        impl serde::de::Visitor<'_> for Text {
            type Value = SharedText;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a string")
            }

            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<SharedText, E> {
                Ok(SharedText::decoded(text))
            }

            fn visit_string<E: serde::de::Error>(self, text: String) -> Result<SharedText, E> {
                Ok(if text.len() >= SHARED_MIN { SharedText::from(text) } else { SharedText::decoded(&text) })
            }
        }

        deserializer.deserialize_str(Text)
    }
}

#[cfg(test)]
mod shared_text_tests {
    use super::*;

    fn is_known(text: &str) -> bool {
        known(|known| known.contains_key(&key_of(text)))
    }

    /// A long text made twice, by any way of making it, is one allocation while a holder lives; once the last is gone the
    /// next one made is held alone again. A string is moved into the text, and a short text is never looked for.
    #[test]
    fn a_long_text_is_one_allocation_for_every_holder_and_goes_with_the_last() {
        let body = format!("shared text held once: {}", "row ".repeat(SHARED_MIN));
        let (made, at) = (body.clone(), body.as_ptr());
        let moved_from = made.as_ptr();
        let first = SharedText::from(made);
        assert_eq!(first.as_str().as_ptr(), moved_from, "the string is the text, not a copy of it");
        assert_ne!(first.as_str().as_ptr(), at);
        let again = SharedText::from(body.as_str());
        let decoded: SharedText = serde_json::from_value(serde_json::Value::String(body.clone())).expect("a string");
        assert!(first.shares(&again) && first.shares(&decoded), "one allocation for the three");
        assert_eq!(String::from(first.clone()), body);
        drop((again, decoded));
        assert!(is_known(&body));
        drop(first);
        assert!(!is_known(&body), "the table's entry went with the last holder");
        let short = (SharedText::from("short"), SharedText::from("short"));
        assert!(!short.0.shares(&short.1));
        let moved = String::from("a short string");
        let at = moved.as_ptr();
        assert_eq!(SharedText::from(moved).as_str().as_ptr(), at);
    }

    /// The last two holders of a text let go at the same moment, on two threads, again and again: the entry is gone every
    /// time (a holder that read the count before letting go left it behind, and with it the text's bytes).
    #[test]
    fn two_last_holders_letting_go_at_once_leave_no_entry() {
        for round in 0..2_000 {
            let body = format!("round {round} of the concurrent release: {}", "x".repeat(SHARED_MIN));
            let (one, two) = (SharedText::from(body.as_str()), SharedText::from(body.as_str()));
            assert!(one.shares(&two));
            let start = std::sync::Arc::new(std::sync::Barrier::new(2));
            let other = {
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    drop(two);
                })
            };
            start.wait();
            drop(one);
            other.join().expect("the other holder let go");
            assert!(!is_known(&body), "round {round}: the entry outlived both holders");
        }
    }

    /// A text made while its last holder lets go is either that holder's allocation or a new one with an entry of its own:
    /// the release never takes the new one's entry out.
    #[test]
    fn a_text_made_again_while_its_last_holder_lets_go_keeps_its_entry() {
        for round in 0..2_000 {
            let body = format!("round {round} of the release against a new holder: {}", "y".repeat(SHARED_MIN));
            let held = SharedText::from(body.as_str());
            let start = std::sync::Arc::new(std::sync::Barrier::new(2));
            let maker = {
                let (start, body) = (start.clone(), body.clone());
                std::thread::spawn(move || {
                    start.wait();
                    SharedText::from(body)
                })
            };
            start.wait();
            drop(held);
            let made = maker.join().expect("the text was made again");
            assert!(is_known(&body), "round {round}: the held text has its entry");
            assert!(made.shares(&SharedText::from(body.as_str())), "round {round}: and is the one found");
            drop(made);
            assert!(!is_known(&body), "round {round}");
        }
    }
}
