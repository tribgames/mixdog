//! The credential files and loaders: every load of a credential file is a counted credential read.



use super::oauth_credentials::credential_file;
use super::oauth_credentials::load_oauth_credentials;


/// Each load of a credential file is one counted credential read (`mixdog_ai::work`), the file present or not: the
/// describe screens read the files themselves, not through `CredentialFile`, so they move the same counter.
#[test]
fn every_load_of_a_credential_file_is_a_counted_credential_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = credential_file("openai-oauth", &|_| None, dir.path(), dir.path()).unwrap();
    for read in 1..=2 {
        let before = mixdog_ai::work::credential_reads();
        assert_eq!(load_oauth_credentials("openai-oauth", &path, 0, None), None);
        assert!(mixdog_ai::work::credential_reads() > before, "load {read} of a missing credential file moved no credential counter");
    }
}



