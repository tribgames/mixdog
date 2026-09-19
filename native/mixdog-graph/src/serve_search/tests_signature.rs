use super::test_support::request;
use super::*;

#[test]
fn journal_sync_evicts_changed_signatures_and_metadata() {
    let serial = u32::MAX - 17;
    let file_id = u64::MAX - 19;
    let path = PathBuf::from(format!("mixdog-journal-eviction-{file_id}"));
    let identity = crate::serve_search_usn::FileIdentity {
        volume: serial,
        file_id,
    };
    let shard = content_signature_shard(&path);
    raw_content_signature_cache()[shard]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            path.clone(),
            ContentSignatureEntry {
                size: 1,
                modified_ns: 1,
                identity: Some(identity),
                persisted: true,
                signature: TrigramSignature::new(),
            },
        );
    file_metadata_cache()[shard]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            path.clone(),
            FileMetadataEntry {
                size: 1,
                modified_ns: 1,
                mtime_ms: 1,
                identity: Some(identity),
            },
        );
    apply_content_signature_journal_sync(crate::serve_search_usn::SyncResult {
        trusted: true,
        volume_serial: Some(serial),
        changed: HashSet::from([file_id]),
        parents: HashSet::new(),
    });
    assert!(!raw_content_signature_cache()[shard]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains_key(&path));
    assert!(!file_metadata_cache()[shard]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains_key(&path));
    trusted_usn_volumes()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&serial);
}

#[test]
fn binary_signature_payload_stays_within_the_memory_budget() {
    assert_eq!(
        CONTENT_SIGNATURE_WORDS * std::mem::size_of::<u64>() * 2,
        4096
    );
    assert!(
        CONTENT_SIGNATURE_WORDS * std::mem::size_of::<u64>() * 2 * CONTENT_SIGNATURE_CACHE_MAX
            <= 64 * 1024 * 1024
    );
    let mut bytes = std::io::Cursor::new(Vec::new());
    bytes.write_all(&(u128::MAX - 7).to_le_bytes()).unwrap();
    bytes.set_position(0);
    assert_eq!(read_snapshot_u128(&mut bytes).unwrap(), u128::MAX - 7);
}

#[test]
fn trusted_cached_signature_is_reused_without_rebuilding() {
    let serial = u32::MAX - 31;
    let file_id = u64::MAX - 37;
    let path = PathBuf::from(format!("mixdog-signature-reuse-{file_id}"));
    let mut signature = TrigramSignature::new();
    signature.push(b"prefix needle suffix");
    signature.complete = true;
    let shard = content_signature_shard(&path);
    raw_content_signature_cache()[shard]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            path.clone(),
            ContentSignatureEntry {
                size: 1,
                modified_ns: 1,
                identity: Some(crate::serve_search_usn::FileIdentity {
                    volume: serial,
                    file_id,
                }),
                persisted: false,
                signature,
            },
        );
    let trust = TrustSnapshot {
        usn_volumes: Arc::new(HashSet::from([serial])),
        watch_roots: Arc::new(Vec::new()),
    };
    let present = b"needle"
        .windows(3)
        .map(|window| trigram_bits(window[0], window[1], window[2]))
        .collect::<Vec<_>>();
    assert_eq!(
        cached_signature_state(&path, &[present], false, &trust),
        CachedSignatureState::Reusable
    );
    raw_content_signature_cache()[shard]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&path);
}

#[test]
fn exact_watcher_invalidation_does_not_scan_or_remove_siblings() {
    let changed = PathBuf::from("src/change.rs");
    let sibling = PathBuf::from("src/change.rs.backup");
    for path in [&changed, &sibling] {
        raw_content_signature_cache()[content_signature_shard(path)]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                path.clone(),
                ContentSignatureEntry {
                    size: 1,
                    modified_ns: 1,
                    identity: None,
                    persisted: false,
                    signature: TrigramSignature::new(),
                },
            );
    }
    invalidate_content_signatures(std::slice::from_ref(&changed), false);
    assert!(
        !raw_content_signature_cache()[content_signature_shard(&changed)]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&changed)
    );
    assert!(
        raw_content_signature_cache()[content_signature_shard(&sibling)]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&sibling)
    );
    raw_content_signature_cache()[content_signature_shard(&sibling)]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&sibling);
}

#[test]
fn trigram_signature_only_excludes_impossible_literal_patterns() {
    let mut signature = TrigramSignature::new();
    signature.push(b"prefix needle suffix");
    signature.complete = true;
    let present = b"needle"
        .windows(3)
        .map(|window| trigram_bits(window[0], window[1], window[2]))
        .collect::<Vec<_>>();
    let absent = b"definitely-absent"
        .windows(3)
        .map(|window| trigram_bits(window[0], window[1], window[2]))
        .collect::<Vec<_>>();
    assert!(!signature_excludes_requirements(
        &signature,
        &[present],
        false
    ));
    assert!(signature_excludes_requirements(
        &signature,
        &[absent],
        false
    ));
    let folded = b"NEEDLE"
        .windows(3)
        .map(|window| {
            trigram_bits(
                window[0].to_ascii_lowercase(),
                window[1].to_ascii_lowercase(),
                window[2].to_ascii_lowercase(),
            )
        })
        .collect::<Vec<_>>();
    assert!(!signature_excludes_requirements(
        &signature,
        &[folded],
        true
    ));
}

#[test]
fn literal_prefilter_accepts_utf8_and_extracts_mandatory_regex_runs() {
    let utf8 = parse_args(&request(&["-F", "-e", "한글", "."], 10).args).unwrap();
    assert!(utf8.literal_trigrams.is_some());

    let regex = parse_args(&request(&["-e", "log.*Error", "."], 10).args).unwrap();
    assert!(regex.literal_trigrams.is_some());
    assert_eq!(mandatory_regex_literal("log.*Error").unwrap(), b"Error");
    assert!(mandatory_regex_literal("(optional)?required").is_none());

    let utf8_folded = parse_args(&request(&["-i", "-F", "-e", "한글", "."], 10).args).unwrap();
    assert!(utf8_folded.literal_trigrams.is_none());
}
