//! What one response's input-cache counters prove about the transcript's tail entry, read against the manifest of the
//! body that was sent.
//!
//! The counters are a contiguous cached read, then creation spans at the reported tiers, then uncached input. A tail
//! touch is asserted only when every placement consistent with the manifest and the counts reaches the same tail: a
//! creation at the tail's tier proves its write when no earlier marker of that tier could have produced it (an earlier
//! same-tier marker explains nothing only when its proven extent lies within the read); a read with no creation
//! refreshes an earlier entry only when it ends exactly at that entry's proven extent and the entry is reachable. Missing
//! counters, an inconsistent split, or several fitting placements prove nothing.

use mixdog_core_api::domain::cache_tail::{Counters, Digest, WireManifest};

/// An entry whose cumulative provider-token end is proven.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Extent {
    pub block: usize,
    pub digest: Digest,
    pub tokens: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Evidence {
    /// The tail entry was written at its requested tier. It is the last marker, so its end is `read + total creation`.
    Wrote { extent: u64 },
    /// Nothing was written; the read ended exactly at this earlier entry, which it refreshed.
    Refreshed { block: usize, digest: Digest },
    /// The whole report says nothing was read and nothing written: the provider holds no entry of this request.
    Untouched,
    /// Nothing about the tail follows from these counters.
    Unknown,
}

/// The 5-minute and 1-hour creation, when the counters determine both and they add up.
fn split(counters: &Counters, created: u64) -> Option<(u64, u64)> {
    let (five, hour) = match (counters.created_5m, counters.created_1h) {
        (Some(five), Some(hour)) => (five, hour),
        (None, Some(hour)) => (created.checked_sub(hour)?, hour),
        (Some(five), None) => (five, created.checked_sub(five)?),
        (None, None) if created == 0 => (0, 0),
        (None, None) => return None,
    };
    (five + hour == created).then_some((five, hour))
}

/// What `counters` prove about `manifest`'s tail; `known` are the entries of the same route whose extents are proven.
pub fn interpret(manifest: &WireManifest, counters: Counters, known: &[Extent]) -> Evidence {
    let Some(tail) = manifest.tail_marker() else { return Evidence::Unknown };
    let (Some(read), Some(created)) = (counters.read, counters.created) else { return Evidence::Unknown };
    let Some((five, hour)) = split(&counters, created) else { return Evidence::Unknown };
    if created > 0 {
        let tail_is_hour = tail.ttl_ms == mixdog_core_api::domain::cache_tail::TTL_1H_MS;
        let (at_tier, other_tier) = if tail_is_hour { (hour, five) } else { (five, hour) };
        if at_tier == 0 {
            return Evidence::Unknown;
        }
        let earlier = &manifest.markers[..manifest.tail.unwrap_or(0)];
        // A marker whose proven end lies within the read was read, not written.
        let unread = |m: &&mixdog_core_api::domain::cache_tail::Marker| !known.iter().any(|e| e.block == m.block && e.digest == m.digest && e.tokens <= read);
        // Creation at the other tier must come from an earlier marker of that tier that was not read: with none, the report
        // is inconsistent with the body and proves nothing.
        if other_tier > 0 && !earlier.iter().filter(|m| m.ttl_ms != tail.ttl_ms).any(|m| unread(&m)) {
            return Evidence::Unknown;
        }
        // The provider writes an entry at every marker past the read, and a marker's prefix holds every earlier one's: a
        // creation at the tail's tier wrote the tail, whichever earlier marker of that tier it wrote with it.
        return Evidence::Wrote { extent: read + created };
    }
    if read == 0 {
        return Evidence::Untouched;
    }
    let mut fits = known.iter().filter(|e| e.tokens == read && manifest.reaches(e.block, e.digest));
    match (fits.next(), fits.next()) {
        (Some(only), None) => Evidence::Refreshed { block: only.block, digest: only.digest },
        _ => Evidence::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::cache_tail::{Marker, Zone, TTL_1H_MS, TTL_5M_MS};

    use super::*;

    fn d(n: u8) -> Digest {
        Digest([n; 32])
    }

    /// System at 1h on block 0, optional tier3 at 1h on block 1, the message tail at `tail_ttl` on block 9.
    fn manifest(tail_ttl: u64, tier3: bool) -> WireManifest {
        let mut markers = vec![Marker { zone: Zone::System, ttl_ms: TTL_1H_MS, block: 0, digest: d(0) }];
        if tier3 {
            markers.push(Marker { zone: Zone::System, ttl_ms: TTL_1H_MS, block: 1, digest: d(1) });
        }
        markers.push(Marker { zone: Zone::Messages, ttl_ms: tail_ttl, block: 9, digest: d(9) });
        let tail = Some(markers.len() - 1);
        WireManifest { markers, boundaries: (0..12).map(d).collect(), tail }
    }

    /// A body whose only marker is the five-minute message tail cannot have written at the hour tier: a report that says
    /// so is inconsistent with the body and proves nothing; a read-back hour marker cannot explain new hour creation either.
    #[test]
    fn creation_at_a_tier_no_unread_marker_explains_proves_nothing() {
        let only_tail = WireManifest { markers: vec![Marker { zone: Zone::Messages, ttl_ms: TTL_5M_MS, block: 9, digest: d(9) }], boundaries: (0..12).map(d).collect(), tail: Some(0) };
        assert_eq!(interpret(&only_tail, counters(0, 300, 200), &[]), Evidence::Unknown);
        assert_eq!(interpret(&only_tail, counters(0, 300, 0), &[]), Evidence::Wrote { extent: 300 });
        let read_system = Extent { block: 0, digest: d(0), tokens: 800 };
        assert_eq!(interpret(&manifest(TTL_5M_MS, false), counters(800, 300, 200), &[read_system]), Evidence::Unknown, "the hour marker was read");
        assert_eq!(interpret(&manifest(TTL_5M_MS, false), counters(800, 300, 0), &[read_system]), Evidence::Wrote { extent: 1100 });
    }

    fn counters(read: u64, five: u64, hour: u64) -> Counters {
        Counters { read: Some(read), created: Some(five + hour), created_5m: Some(five), created_1h: Some(hour) }
    }

    #[test]
    fn a_five_minute_creation_only_the_tail_can_make_proves_its_write_and_extent() {
        assert_eq!(interpret(&manifest(TTL_5M_MS, true), counters(1000, 300, 2000), &[]), Evidence::Wrote { extent: 3300 });
        assert_eq!(interpret(&manifest(TTL_5M_MS, true), counters(1000, 300, 0), &[]), Evidence::Wrote { extent: 1300 }, "a read of the system then the tail's own write");
    }

    #[test]
    fn pure_hour_writes_cannot_prove_a_five_minute_tail() {
        assert_eq!(interpret(&manifest(TTL_5M_MS, true), counters(0, 0, 5000), &[]), Evidence::Unknown);
    }

    #[test]
    fn a_creation_at_the_tails_tier_proves_the_tail_beside_earlier_markers_of_that_tier() {
        let m = manifest(TTL_1H_MS, false);
        assert_eq!(interpret(&m, counters(0, 0, 5000), &[]), Evidence::Wrote { extent: 5000 }, "the system and the tail were both written");
        assert_eq!(interpret(&m, counters(800, 0, 4200), &[]), Evidence::Wrote { extent: 5000 }, "the system was read and the tail written");
    }

    #[test]
    fn a_read_refreshes_only_the_reachable_entry_it_ends_at() {
        let m = manifest(TTL_5M_MS, true);
        let prior = Extent { block: 6, digest: d(6), tokens: 4000 };
        assert_eq!(interpret(&m, counters(4000, 0, 0), &[prior]), Evidence::Refreshed { block: 6, digest: d(6) });
        assert_eq!(interpret(&m, counters(3999, 0, 0), &[prior]), Evidence::Unknown, "a positive read that ends elsewhere proves nothing");
        let unreachable = Extent { digest: d(77), ..prior };
        assert_eq!(interpret(&m, counters(4000, 0, 0), &[unreachable]), Evidence::Unknown);
        let twin = Extent { block: 7, digest: d(7), tokens: 4000 };
        assert_eq!(interpret(&m, counters(4000, 0, 0), &[prior, twin]), Evidence::Unknown, "two placements fit");
    }

    #[test]
    fn missing_or_inconsistent_counters_prove_nothing() {
        let m = manifest(TTL_5M_MS, true);
        assert_eq!(interpret(&m, Counters { read: None, ..counters(0, 300, 0) }, &[]), Evidence::Unknown);
        assert_eq!(interpret(&m, Counters { created: None, ..counters(0, 300, 0) }, &[]), Evidence::Unknown);
        assert_eq!(interpret(&m, Counters { created: Some(400), created_5m: None, created_1h: None, read: Some(0) }, &[]), Evidence::Unknown, "no split");
        assert_eq!(interpret(&m, Counters { created: Some(400), ..counters(0, 300, 0) }, &[]), Evidence::Unknown, "a split that does not add up");
        assert_eq!(interpret(&m, counters(0, 0, 0), &[]), Evidence::Untouched, "a whole report of nothing read or written");
        let no_tail = WireManifest { tail: None, ..m };
        assert_eq!(interpret(&no_tail, counters(0, 300, 0), &[]), Evidence::Unknown, "no transcript marker: no tail to prove");
    }

    /// A trailing uncached suffix is input after the last marker: it changes nothing about the tail.
    #[test]
    fn uncached_input_after_the_tail_does_not_move_its_extent() {
        let mut c = counters(1000, 300, 0);
        c.created = Some(300);
        assert_eq!(interpret(&manifest(TTL_5M_MS, false), c, &[]), Evidence::Wrote { extent: 1300 });
    }
}
