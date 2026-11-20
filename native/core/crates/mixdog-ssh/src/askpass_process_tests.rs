//! Which questions of a connect are a refused answer coming back: identity, never time. The server's `answer` is called as a
//! helper's request reaches it; the wire has its own tests in `askpass_tests.rs`.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::*;

struct Recorder(Mutex<Vec<AskpassQuestion>>);

#[async_trait]
impl AskpassPrompter for Recorder {
    async fn ask(&self, question: AskpassQuestion) -> Option<String> {
        let mut asked = self.0.lock().unwrap();
        asked.push(question);
        Some(format!("secret-{}", asked.len()))
    }
}

impl Recorder {
    fn retries(&self) -> Vec<bool> {
        self.0.lock().unwrap().iter().map(|question| question.retry).collect()
    }
    fn prompts(&self) -> Vec<String> {
        self.0.lock().unwrap().iter().map(|question| question.prompt.clone()).collect()
    }
}

async fn session(prompter: Arc<Recorder>) -> AskpassSession {
    let io = mixdog_rt::testing::tokens().durability_io;
    AskpassServer::new(prompter, io, Platform::current()).start(Path::new("helper")).await.unwrap()
}

const fn who(child: u64, process: u64) -> Asker {
    Asker { child, process }
}

async fn secret(session: &AskpassSession, prompt: &str, asker: Asker) -> String {
    session.inner.answer(prompt, asker).await.expect("answered").to_string()
}

#[tokio::test]
async fn each_ssh_invocation_gets_its_own_number_in_its_environment() {
    let session = session(Arc::new(Recorder(Mutex::new(Vec::new())))).await;
    let number = |env: Vec<(String, String)>| env.into_iter().find(|(name, _)| name == CHILD_VARIABLE).map(|(_, value)| value);
    assert_eq!(number(session.child_env()).as_deref(), Some("1"));
    assert_eq!(number(session.child_env()).as_deref(), Some("2"));
    assert_eq!(number(session.env()), None, "the session's own environment is the same for every invocation");
    session.close().await;
}

#[tokio::test]
async fn an_invocation_prepared_between_two_prompts_does_not_turn_the_second_into_a_new_login() {
    let prompter = Arc::new(Recorder(Mutex::new(Vec::new())));
    let session = session(prompter.clone()).await;
    let prompt = "root@h's password: ";
    assert_eq!(secret(&session, prompt, who(1, 100)).await, "secret-1");
    let _another_spawn_prepared = session.child_env();
    // The first invocation's process asks again: refused, however many spawns were prepared meanwhile.
    assert_eq!(secret(&session, prompt, who(1, 100)).await, "secret-2");
    assert_eq!(prompter.retries(), [false, true]);
    session.close().await;
}

#[tokio::test]
async fn a_later_invocation_needing_the_same_credential_is_given_the_answer_without_a_retry() {
    let prompter = Arc::new(Recorder(Mutex::new(Vec::new())));
    let session = session(prompter.clone()).await;
    let prompt = "root@h's password: ";
    assert_eq!(secret(&session, prompt, who(1, 100)).await, "secret-1");
    assert_eq!(secret(&session, prompt, who(2, 200)).await, "secret-1");
    assert_eq!(prompter.retries(), [false], "the user was asked once");
    // The later invocation's own process refused it: that one asks the user, as a retry, and the new answer is kept.
    assert_eq!(secret(&session, prompt, who(2, 200)).await, "secret-2");
    assert_eq!(secret(&session, prompt, who(3, 300)).await, "secret-2");
    assert_eq!(prompter.retries(), [false, true]);
    session.close().await;
}

#[tokio::test]
async fn distinct_questions_of_one_connect_are_not_retries_of_each_other() {
    let prompter = Arc::new(Recorder(Mutex::new(Vec::new())));
    let session = session(prompter.clone()).await;
    secret(&session, "a@one's password: ", who(1, 100)).await;
    secret(&session, "Enter passphrase for key '/k': ", who(1, 100)).await;
    secret(&session, "a@two's password: ", who(1, 100)).await;
    assert_eq!(prompter.retries(), [false, false, false]);
    assert_eq!(prompter.prompts().len(), 3);
    session.close().await;
}

#[tokio::test]
async fn a_jump_host_and_the_target_asking_identical_text_are_two_authentications() {
    let prompter = Arc::new(Recorder(Mutex::new(Vec::new())));
    let session = session(prompter.clone()).await;
    let prompt = "Password: ";
    // One invocation, two ssh processes (the jump host's, then the target's) with the same text.
    assert_eq!(secret(&session, prompt, who(1, 100)).await, "secret-1");
    assert_eq!(secret(&session, prompt, who(1, 101)).await, "secret-2", "the target is asked, and is not a retry");
    assert_eq!(prompter.retries(), [false, false]);
    // A later invocation walks the same two steps: each gets its own step's answer.
    assert_eq!(secret(&session, prompt, who(2, 200)).await, "secret-1");
    assert_eq!(secret(&session, prompt, who(2, 201)).await, "secret-2");
    assert_eq!(prompter.retries(), [false, false]);
    // The jump host's process asking again was refused: that one is a retry, the target's answer is untouched.
    assert_eq!(secret(&session, prompt, who(2, 200)).await, "secret-3");
    assert_eq!(prompter.retries(), [false, false, true]);
    assert_eq!(secret(&session, prompt, who(3, 300)).await, "secret-3");
    assert_eq!(secret(&session, prompt, who(3, 301)).await, "secret-2");
    session.close().await;
}

#[tokio::test]
async fn a_failed_invocations_answer_is_not_replayed_to_a_new_attempt() {
    let prompter = Arc::new(Recorder(Mutex::new(Vec::new())));
    let first = session(prompter.clone()).await;
    let prompt = "root@h's password: ";
    assert_eq!(secret(&first, prompt, who(1, 100)).await, "secret-1");
    // The attempt fails and ends; the next attempt has a session of its own and asks afresh (not as a retry).
    first.close().await;
    let next = session(prompter.clone()).await;
    assert_eq!(secret(&next, prompt, who(1, 100)).await, "secret-2");
    assert_eq!(prompter.retries(), [false, false]);
    next.close().await;
}

#[tokio::test]
async fn the_session_names_a_secret_as_refused_only_when_its_process_asked_again() {
    let prompter = Arc::new(Recorder(Mutex::new(Vec::new())));
    let session = session(prompter).await;
    secret(&session, "Enter passphrase for key '/k': ", who(1, 100)).await;
    secret(&session, "h's password: ", who(1, 100)).await;
    assert_eq!(session.refused(), None, "answers alone are no evidence");
    secret(&session, "h's password: ", who(2, 200)).await;
    assert_eq!(session.refused(), None, "a later invocation using an answer is no evidence either");
    secret(&session, "h's password: ", who(1, 100)).await;
    assert_eq!(session.refused(), Some(AskpassKind::Password));
    session.close().await;
}
