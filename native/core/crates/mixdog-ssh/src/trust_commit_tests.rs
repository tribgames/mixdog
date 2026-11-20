//! What a confirmation is checked against where it takes effect: the key the user reviewed and the entries for each endpoint in
//! the files its ssh consults as they were then, read again under the writer's lock. Every rejection leaves every file byte for
//! byte as it was.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use sha1::Sha1;

use super::*;

const SPEC: &str = "box.example";

fn claim_of(owner: &str, spec: &str, key: &str) -> Claim {
    Claim::new(owner.to_owned(), spec.to_owned(), "ssh-ed25519".to_owned(), key.to_owned())
}

fn owner(raw: &str) -> String {
    owner_of(&crate::command::parse_ssh_target(raw).expect("a target"))
}

/// Mixdog's own known_hosts and one user file, in one folder (the folder of the state lock).
struct Files {
    _dir: tempfile::TempDir,
    own: PathBuf,
    user: PathBuf,
}

impl Files {
    fn new(own: &str, user: &str) -> Self {
        let dir = tempfile::tempdir().expect("a folder");
        let (own_file, user_file) = (dir.path().join("known_hosts"), dir.path().join("user_known_hosts"));
        fs::write(&own_file, own).expect("written");
        fs::write(&user_file, user).expect("written");
        Self { _dir: dir, own: own_file, user: user_file }
    }

    fn dir(&self) -> &Path {
        self.own.parent().expect("a folder")
    }

    fn own_text(&self) -> String {
        fs::read_to_string(&self.own).expect("read")
    }

    fn user_text(&self) -> String {
        fs::read_to_string(&self.user).expect("read")
    }

    /// What an inspection of the servers `specs`, each consulting both files, records of them as they are now.
    fn shown(&self, specs: &[&str]) -> Vec<EndpointTrust> {
        let read = |file: &Path| fs::read_to_string(file).ok();
        specs.iter().map(|spec| EndpointTrust::of(spec, vec![self.own.clone(), self.user.clone()], Vec::new(), Some(&self.own), read)).collect()
    }

    fn commit(&self, shown: &[EndpointTrust], claims: &[Claim]) -> Result<(), StateError> {
        commit_in(&self.own, shown, claims)
    }

    fn rotate(&self, shown: &[EndpointTrust], claim: &Claim, old_key: &str) -> Result<(), StateError> {
        rotate_in(&self.own, shown, claim, old_key)
    }
}

/// The line of Mixdog's own file for `spec` under `key`, marked with `owners` as earlier builds wrote it.
fn pin(spec: &str, key: &str, owners: &[&str]) -> String {
    let mut owners: Vec<&str> = owners.to_vec();
    owners.sort_unstable();
    format!("{spec} ssh-ed25519 {key} mixdog-pin-v1={}\n", owners.join(","))
}

#[test]
fn two_desktops_reviewing_one_old_key_the_second_rotation_is_refused_and_the_newer_key_and_its_mark_survive() {
    let (a, b) = (owner("a@one"), owner("b@two"));
    let files = Files::new(&pin(SPEC, "KA", &[&a, &b]), "");
    // Both reviewed A→(B or C): the old key A is what the user was shown replaced.
    let shown = files.shown(&[SPEC]);
    files.rotate(&shown, &claim_of(&a, SPEC, "KC"), "KA").expect("the first confirmation rotates");
    let after_c = files.own_text();
    assert_eq!(after_c, pin(SPEC, "KC", &[&a, &b]));

    assert_eq!(files.rotate(&shown, &claim_of(&b, SPEC, "KB"), "KA"), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), after_c, "C and its mark survive byte for byte");
    // The pin itself refuses a stale old key whatever the review says.
    assert_eq!(rotate(after_c.as_bytes(), &claim_of(&b, SPEC, "KB"), "KA"), Err(StateError::Conflict));
}

#[test]
fn a_confirmation_for_a_key_another_desktop_already_rotated_to_is_spent_and_not_an_upsert() {
    let (a, b) = (owner("a@one"), owner("b@two"));
    let files = Files::new(&pin(SPEC, "KA", &[&a]), "");
    let shown = files.shown(&[SPEC]);
    files.rotate(&shown, &claim_of(&b, SPEC, "KB"), "KA").expect("the other desktop rotated to the proposal");
    let held = files.own_text();
    assert_eq!(files.rotate(&shown, &claim_of(&a, SPEC, "KB"), "KA"), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), held, "the old-key confirmation changed nothing");
}

#[test]
fn an_entry_for_another_host_changed_after_the_review_does_not_cancel_a_rotation() {
    let a = owner("a@one");
    let files = Files::new(&pin(SPEC, "KA", &[&a]), "");
    let shown = files.shown(&[SPEC]);
    let mut edited = files.own_text();
    edited.push_str("unrelated.example ssh-ed25519 KU\n");
    fs::write(&files.own, &edited).expect("an unrelated edit");

    files.rotate(&shown, &claim_of(&a, SPEC, "KB"), "KA").expect("the entries for the endpoint are unchanged");
    assert_eq!(files.own_text(), format!("{}unrelated.example ssh-ed25519 KU\n", pin(SPEC, "KB", &[&a])));
}

#[test]
fn a_revocation_added_after_the_inspection_refuses_even_a_confirmation_that_writes_nothing() {
    let (a, b) = (owner("a@one"), owner("b@two"));
    let files = Files::new(&pin(SPEC, "KB", &[&a]), "");
    let shown = files.shown(&[SPEC]);
    fs::write(&files.user, "@revoked box.example ssh-ed25519 KB\n").expect("revoked after the inspection");
    let (own_before, user_before) = (files.own_text(), files.user_text());

    assert_eq!(files.commit(&shown, &[claim_of(&b, SPEC, "KB")]), Err(StateError::Revoked), "the key already pinned is no success");
    assert_eq!((files.own_text(), files.user_text()), (own_before, user_before));
}

#[test]
fn a_wildcard_revocation_a_hashed_one_and_a_conflicting_wildcard_apply_and_a_negation_exempts() {
    let a = owner("a@one");
    let files = Files::new("", "");
    let shown = files.shown(&[SPEC]);
    let claim = claim_of(&a, SPEC, "KB");

    fs::write(&files.user, "@revoked *.example ssh-ed25519 KB\n").expect("written");
    assert_eq!(files.commit(&shown, std::slice::from_ref(&claim)), Err(StateError::Revoked), "wildcard");

    let salt = b"0123456789abcdefghij";
    let mut mac = Hmac::<Sha1>::new_from_slice(salt).expect("a key");
    mac.update(SPEC.as_bytes());
    let hashed = format!("|1|{}|{}", STANDARD.encode(salt), STANDARD.encode(mac.finalize().into_bytes()));
    fs::write(&files.user, format!("@revoked {hashed} ssh-ed25519 KB\n")).expect("written");
    assert_eq!(files.commit(&shown, std::slice::from_ref(&claim)), Err(StateError::Revoked), "hashed");

    fs::write(&files.user, "*.example ssh-ed25519 KX\n").expect("written");
    assert_eq!(files.commit(&shown, std::slice::from_ref(&claim)), Err(StateError::EvidenceChanged), "an applicable wildcard that names another key");

    fs::write(&files.user, "@revoked *.example,!box.example ssh-ed25519 KB\n").expect("written");
    files.commit(&shown, std::slice::from_ref(&claim)).expect("a negated name is not covered by the revocation");
    assert_eq!(files.own_text(), pin(SPEC, "KB", &[&a]));
}

#[test]
fn a_rotation_is_refused_by_a_revocation_of_the_new_key_and_by_a_policy_line_and_changes_nothing() {
    let a = owner("a@one");
    let files = Files::new(&pin(SPEC, "KA", &[&a]), "");
    let shown = files.shown(&[SPEC]);

    fs::write(&files.user, "@revoked box.example ssh-ed25519 KC\n").expect("written");
    assert_eq!(files.rotate(&shown, &claim_of(&a, SPEC, "KC"), "KA"), Err(StateError::Revoked));
    assert_eq!(files.own_text(), pin(SPEC, "KA", &[&a]));

    fs::write(&files.user, "").expect("written");
    let with_policy = format!("{}*.example ssh-ed25519 KP\n", pin(SPEC, "KA", &[&a]));
    fs::write(&files.own, &with_policy).expect("a wildcard policy line beside the pin");
    let shown = files.shown(&[SPEC]);
    assert_eq!(files.rotate(&shown, &claim_of(&a, SPEC, "KC"), "KA"), Err(StateError::Manual(files.own.display().to_string())));
    assert_eq!(files.own_text(), with_policy, "opaque bytes are never deleted or interpreted");

    fs::write(&files.own, pin(SPEC, "KA", &[&a])).expect("written");
    fs::write(&files.user, "box.example ssh-ed25519 KU\n").expect("the user's own trust of another key of the type");
    let shown = files.shown(&[SPEC]);
    assert_eq!(files.rotate(&shown, &claim_of(&a, SPEC, "KC"), "KA"), Err(StateError::Manual(files.user.display().to_string())));
}

#[test]
fn a_consulted_file_that_cannot_be_read_refuses_and_one_that_is_not_there_holds_no_entries() {
    let a = owner("a@one");
    let files = Files::new("", "");
    let claim = claim_of(&a, SPEC, "KB");
    let endpoint =
        |file: PathBuf| vec![EndpointTrust::of(SPEC, vec![files.own.clone(), file], Vec::new(), Some(&files.own), |file| fs::read_to_string(file).ok())];

    commit_in(&files.own, &endpoint(files.dir().join("not-there")), std::slice::from_ref(&claim)).expect("a missing optional source is no evidence");

    let folder = files.dir().join("a-folder");
    fs::create_dir(&folder).expect("a folder where a file should be");
    let before = files.own_text();
    let failure = commit_in(&files.own, &endpoint(folder), &[claim_of(&a, SPEC, "KB")]);
    assert!(matches!(failure, Err(StateError::Unreadable(_))), "{failure:?}");
    assert_eq!(files.own_text(), before);
}

#[test]
fn a_key_added_for_the_server_after_the_review_refuses_the_confirmation_of_a_key_already_pinned() {
    let (a, b) = (owner("a@one"), owner("b@two"));
    let files = Files::new(&pin(SPEC, "KA", &[&a]), "");
    // The second server was shown A as the one key held for the endpoint.
    let shown = files.shown(&[SPEC]);
    fs::write(&files.user, "*.example ssh-ed25519 KC\n").expect("a wildcard that names another key, added after the review");
    let before = files.own_text();

    assert_eq!(files.commit(&shown, &[claim_of(&b, SPEC, "KA")]), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), before);
}

#[test]
fn a_hop_the_confirmation_writes_nothing_for_is_still_part_of_what_was_confirmed() {
    let a = owner("a@one");
    let hop = "hop.example ssh-ed25519 KH\n";
    let route = ["hop.example", "target.example"];
    let target = [claim_of(&a, "target.example", "KT")];

    // The hop is trusted through the user's own file, so the server claims the target alone.
    let files = Files::new("", hop);
    let shown = files.shown(&route);
    fs::write(&files.user, format!("{hop}@revoked hop.example ssh-ed25519 KH\n")).expect("the hop revoked after the review");
    assert_eq!(files.commit(&shown, &target), Err(StateError::Revoked));
    assert_eq!(files.own_text(), "", "the target is not pinned behind a revoked hop");

    fs::write(&files.user, "").expect("the hop's trust removed after the review");
    assert_eq!(files.commit(&shown, &target), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), "");

    fs::write(&files.user, hop).expect("as it was reviewed");
    files.commit(&shown, &target).expect("the entries for each endpoint are the ones shown");
    assert_eq!(files.own_text(), pin("target.example", "KT", &[&a]));
}

#[test]
fn a_certificate_authority_that_comes_or_goes_after_the_review_refuses_the_commit_and_the_rotation() {
    let a = owner("a@one");
    let authority = "@cert-authority *.example ssh-ed25519 KCA\n";

    let files = Files::new(&pin(SPEC, "KA", &[&a]), "");
    let shown = files.shown(&[SPEC]);
    fs::write(&files.user, authority).expect("an authority for the endpoint, added after the review");
    assert_eq!(files.rotate(&shown, &claim_of(&a, SPEC, "KB"), "KA"), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), pin(SPEC, "KA", &[&a]));

    // A hop trusted only through an authority the user has since removed.
    let files = Files::new("", authority);
    let shown = files.shown(&["hop.example", "target.example"]);
    fs::write(&files.user, "").expect("the authority removed");
    assert_eq!(files.commit(&shown, &[claim_of(&a, "target.example", "KT")]), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), "");
}

#[test]
fn the_same_key_confirmed_first_by_another_desktop_and_an_unrelated_edit_leave_the_review_valid() {
    let (a, b) = (owner("a@one"), owner("b@two"));
    let files = Files::new("", "");
    // Both were shown an unknown key for the endpoint: nothing held.
    let shown = files.shown(&[SPEC]);
    files.commit(&shown, &[claim_of(&b, SPEC, "KA")]).expect("the first confirmation pins");
    let mut edited = files.own_text();
    edited.push_str("unrelated.example ssh-ed25519 KU\n");
    fs::write(&files.own, &edited).expect("an unrelated edit");

    files.commit(&shown, &[claim_of(&a, SPEC, "KA")]).expect("the key it confirmed is the one that came");
    assert_eq!(files.own_text(), format!("{}unrelated.example ssh-ed25519 KU\n", pin(SPEC, "KA", &[&b])), "the pin is there once, as it was written");

    // Another key for the endpoint is not the confirmation's own.
    let files = Files::new("", "");
    let shown = files.shown(&[SPEC]);
    files.commit(&shown, &[claim_of(&b, SPEC, "KX")]).expect("another desktop confirmed another key");
    let held = files.own_text();
    assert_eq!(files.commit(&shown, &[claim_of(&a, SPEC, "KA")]), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), held);
}

#[test]
fn an_entry_of_the_users_holding_the_confirmed_key_added_after_the_review_is_not_taken_for_the_apps_own_pin() {
    let a = owner("a@one");
    let files = Files::new("", "");
    // Shown an unknown key for the endpoint: nothing held.
    let shown = files.shown(&[SPEC]);
    let claim = [claim_of(&a, SPEC, "KA")];

    fs::write(&files.user, "*.example ssh-ed25519 KA\n").expect("a wildcard of the user's with that very key, added after the review");
    assert_eq!(files.commit(&shown, &claim), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), "", "no managed pin is made that would outlive the user's wildcard");

    fs::write(&files.user, "").expect("written");
    let unmarked = "box.example ssh-ed25519 KA\n";
    fs::write(&files.own, unmarked).expect("an unmarked line with that key in Mixdog's own file, added after the review");
    assert_eq!(files.commit(&shown, &claim), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), unmarked);
}

#[test]
fn a_route_is_checked_whole_and_a_refusal_on_the_target_leaves_the_hop_unwritten() {
    let a = owner("a@one");
    let files = Files::new("", "");
    let shown = files.shown(&["hop.example", "target.example"]);
    fs::write(&files.user, "@revoked target.example ssh-ed25519 KT\n").expect("the target revoked after the review");
    let route = [claim_of(&a, "hop.example", "KH"), claim_of(&a, "target.example", "KT")];
    assert_eq!(files.commit(&shown, &route), Err(StateError::Revoked));
    assert_eq!(files.own_text(), "", "no partial hop claim");
}

#[test]
fn an_entry_written_twice_at_the_review_and_once_at_the_confirmation_refuses_it() {
    let a = owner("a@one");
    let twice = "box.example ssh-ed25519 KU\nbox.example ssh-ed25519 KU\n";
    let files = Files::new("", twice);
    let shown = files.shown(&[SPEC]);
    fs::write(&files.user, "box.example ssh-ed25519 KU\n").expect("one of the two removed");
    assert_eq!(files.commit(&shown, &[claim_of(&a, SPEC, "KB")]), Err(StateError::EvidenceChanged));
    assert_eq!(files.own_text(), "");
}
