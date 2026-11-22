//! Who may replace the model's files. They have at most one owner at a time ([`Claim`]), which is
//! the only way to own them and releases them once, when it is dropped. An automatic action (a
//! refresh a judgment asked for, the repair after a load failure) is decided under an [`Unowned`]
//! and owns the files only if no install has started since; an explicit install or repair owns
//! them whenever they are free.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::tool_state::StateTick;

/// The ownership of the model's files.
pub(crate) struct Files {
    /// Twice the claims taken, plus one while one is held: one word, so "nobody owns the files" and
    /// "this many installs have started" are a single observation.
    word: AtomicU64,
    /// Bumped at every release.
    tick: StateTick,
}

/// Nobody owned the files, and no install has started since if a claim still accepts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Unowned(u64);

/// The files' one owner, until it is dropped.
#[must_use = "the files are released when the claim is dropped"]
pub(crate) struct Claim<'a>(&'a Files);

impl Files {
    pub(crate) fn new(tick: StateTick) -> Self {
        Self { word: AtomicU64::new(0), tick }
    }

    /// None while the files are owned.
    pub(crate) fn unowned(&self) -> Option<Unowned> {
        let word = self.word.load(Ordering::Acquire);
        (word & 1 == 0).then_some(Unowned(word))
    }

    /// Owns the files if nobody does and, with `decided`, no claim was taken since that observation.
    pub(crate) fn claim(&self, decided: Option<Unowned>) -> Option<Claim<'_>> {
        let take = |word: u64| (word & 1 == 0 && decided.is_none_or(|Unowned(at)| at == word)).then_some(word + 3);
        self.word.try_update(Ordering::AcqRel, Ordering::Acquire, take).ok().map(|_| Claim(self))
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.0.word.fetch_sub(1, Ordering::Release);
        self.0.tick.bump();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_files_have_one_owner_and_an_automatic_claim_needs_no_claim_since_it_was_decided() {
        let files = Files::new(StateTick::default());
        let decided = files.unowned().expect("nobody owns the files");

        let owner = files.claim(None).expect("free files are claimed");
        assert!(files.unowned().is_none());
        assert!(files.claim(None).is_none() && files.claim(Some(decided)).is_none(), "one owner at a time");
        drop(owner);

        assert!(files.claim(Some(decided)).is_none(), "an install started since");
        assert!(files.unowned().is_some(), "a refused claim owns nothing");
        let again = files.unowned().expect("nobody owns the files");
        drop(files.claim(None).expect("an explicit claim is not held to an earlier moment"));
        assert!(files.claim(Some(again)).is_none());
        let now = files.unowned().expect("nobody owns the files");
        drop(files.claim(Some(now)).expect("nothing started since"));
        assert!(files.unowned().is_some());
    }
}
