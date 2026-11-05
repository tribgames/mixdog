//! The server identity, the challenge/hello exchange and the browser-side handshake (the test
//! peer and the Rust client both use `create_client_handshake`).

use p256::SecretKey;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::channel::{Channel, HandshakeState, Role, TransportKeys, cipher};
use super::kdf::{SessionMaterial, handshake_transcript, hello_proof, public_key_b64, verify_hello_proof};
use super::sealed::PairingMaterial;
use super::{E2eeError, VERSION, b64, is_b64url_len, random, unb64};

/// `relay-e2ee.json`: the PC's long-lived E2EE identity, in the file format 1.4.5 wrote.
#[derive(Clone)]
pub struct ServerIdentity {
    pub server_public_key: String,
    pub pairing_secret: String,
    secret: SecretKey,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    version: u64,
    server_public_key: String,
    pairing_secret: String,
    private_key_jwk: Value,
    public_key_jwk: Value,
}

/// A WebCrypto private JWK carries `ext`/`key_ops`, which the JWK parser refuses; only the
/// key members are handed over.
pub fn secret_from_jwk(jwk: &Value) -> Option<SecretKey> {
    let mut key = Map::new();
    for member in ["kty", "crv", "x", "y", "d"] {
        key.insert(member.into(), jwk.get(member)?.clone());
    }
    SecretKey::from_jwk_str(&Value::Object(key).to_string()).ok()
}

impl ServerIdentity {
    pub fn generate() -> Self {
        let secret = SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        Self {
            server_public_key: public_key_b64(&secret.public_key()),
            pairing_secret: b64(&random::<32>()),
            secret,
        }
    }

    /// `None` for anything that is not a valid identity: the caller replaces it.
    pub fn from_json(text: &str) -> Option<Self> {
        let file: IdentityFile = serde_json::from_str(text).ok()?;
        if file.version != VERSION {
            return None;
        }
        let secret = secret_from_jwk(&file.private_key_jwk)?;
        let valid = public_key_b64(&secret.public_key()) == file.server_public_key
            && unb64(&file.pairing_secret).ok()?.len() == 32;
        valid.then_some(Self {
            server_public_key: file.server_public_key,
            pairing_secret: file.pairing_secret,
            secret,
        })
    }

    pub fn to_json(&self) -> String {
        let jwk = |text: String| serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
        let file = IdentityFile {
            version: VERSION,
            server_public_key: self.server_public_key.clone(),
            pairing_secret: self.pairing_secret.clone(),
            private_key_jwk: jwk(self.secret.to_jwk_string().to_string()),
            public_key_jwk: jwk(self.secret.public_key().to_jwk_string()),
        };
        serde_json::to_string_pretty(&file).unwrap_or_default()
    }

    pub fn pairing(&self) -> PairingMaterial {
        PairingMaterial {
            version: VERSION,
            server_public_key: self.server_public_key.clone(),
            pairing_secret: self.pairing_secret.clone(),
        }
    }

    pub(crate) fn secret(&self) -> &SecretKey {
        &self.secret
    }
}

/// `e2ee-challenge`, kept exactly as offered: the transcript covers it member for member.
#[derive(Clone, Debug)]
pub struct Challenge {
    raw: Value,
}

impl Challenge {
    /// A fresh challenge carrying the given capability members (`binaryFrames`, `deflate`,
    /// `mediaE2ee`, `nativePush`, `transportWebrtc`, ...), each with value 1.
    pub fn create(flags: &[&str]) -> Self {
        let mut map = Map::new();
        map.insert("type".into(), "e2ee-challenge".into());
        map.insert("version".into(), VERSION.into());
        map.insert("challenge".into(), b64(&random::<32>()).into());
        for flag in flags {
            map.insert((*flag).into(), 1.into());
        }
        Self { raw: Value::Object(map) }
    }

    pub fn parse(value: Value) -> Result<Self, E2eeError> {
        let ok = value["type"] == "e2ee-challenge"
            && value["version"] == VERSION
            && value["challenge"].as_str().is_some_and(|c| is_b64url_len(c, 43));
        if ok { Ok(Self { raw: value }) } else { Err(E2eeError::Invalid("Unsupported relay encryption handshake.")) }
    }

    pub fn challenge(&self) -> &str {
        self.raw["challenge"].as_str().unwrap_or_default()
    }

    pub fn flag(&self, name: &str) -> bool {
        self.raw[name] == 1
    }

    pub fn as_value(&self) -> &Value {
        &self.raw
    }

    pub fn to_json_string(&self) -> String {
        self.raw.to_string()
    }
}

fn valid_hello(hello: &Value) -> bool {
    hello["type"] == "e2ee-hello"
        && hello["version"] == VERSION
        && hello["challenge"].as_str().is_some_and(|c| is_b64url_len(c, 43))
        && hello["clientPublicKey"].as_str().is_some_and(|c| is_b64url_len(c, 87))
        && hello["proof"].as_str().is_some_and(|c| is_b64url_len(c, 43))
}

/// Whether a JSON text is a well-formed `e2ee-hello` (anything else before the handshake is
/// traffic of the previous leg and is dropped by the caller).
pub fn is_hello(hello: &Value) -> bool {
    valid_hello(hello)
}

pub fn accept_client_hello(
    identity: &ServerIdentity,
    challenge: &Challenge,
    hello: &Value,
) -> Result<Channel, E2eeError> {
    if !valid_hello(hello) || hello["challenge"] != challenge.challenge() {
        return Err(E2eeError::Auth);
    }
    let offered = challenge.flag("transportWebrtc");
    let selected = !hello["transportWebrtc"].is_null();
    if selected
        && !(offered && challenge.flag("binaryFrames") && hello["transportWebrtc"] == 1 && hello["binaryFrames"] == 1)
    {
        return Err(E2eeError::Auth);
    }
    let transcript = (offered || selected).then(|| handshake_transcript(challenge.as_value(), hello));
    let client_public = hello["clientPublicKey"].as_str().unwrap_or_default();
    verify_hello_proof(
        &identity.pairing_secret,
        hello["proof"].as_str().unwrap_or_default(),
        challenge.challenge(),
        &identity.server_public_key,
        client_public,
        if selected { transcript.as_deref() } else { None },
    )?;
    let material = SessionMaterial {
        private: identity.secret(),
        peer_public: client_public,
        pairing_secret: &identity.pairing_secret,
        challenge: challenge.challenge(),
        server_public: &identity.server_public_key,
        client_public,
    };
    let key = material.key("key")?;
    let media = if challenge.flag("mediaE2ee") { Some(material.key("media")?) } else { None };
    let transport = if selected { Some(transport_keys(&material, Role::Server)?) } else { None };
    Ok(Channel::new(
        Role::Server,
        key,
        hello["deflate"] == 1,
        media,
        transport,
        HandshakeState { send: if offered { transcript } else { None }, expect: None },
    ))
}

fn transport_keys(material: &SessionMaterial<'_>, role: Role) -> Result<TransportKeys, E2eeError> {
    let (send, receive) = match role {
        Role::Client => ("client-to-server", "server-to-client"),
        Role::Server => ("server-to-client", "client-to-server"),
    };
    Ok(TransportKeys {
        app_send: cipher(&material.transport_key("app", send)?),
        app_receive: cipher(&material.transport_key("app", receive)?),
        control_send: cipher(&material.transport_key("control", send)?),
        control_receive: cipher(&material.transport_key("control", receive)?),
    })
}

#[derive(Default)]
pub struct ClientHandshakeOptions {
    /// The phone runs the transport stream core and opts in when the challenge offers it.
    pub transport: bool,
    /// Further hello members, added before the proof so the transcript covers them.
    pub hello_fields: Vec<(String, Value)>,
    /// A fixed ephemeral key (known-answer tests); random when absent.
    pub client_key: Option<SecretKey>,
}

/// The browser side: the hello to send and the channel it opens.
pub fn create_client_handshake(
    pairing: &PairingMaterial,
    challenge: &Challenge,
    options: ClientHandshakeOptions,
) -> Result<(Value, Channel), E2eeError> {
    if pairing.version != VERSION {
        return Err(E2eeError::Invalid("Unsupported relay encryption handshake."));
    }
    let pair = options
        .client_key
        .unwrap_or_else(|| SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng));
    let client_public = public_key_b64(&pair.public_key());
    let select = options.transport && challenge.flag("transportWebrtc") && challenge.flag("binaryFrames");
    let deflate = challenge.flag("deflate");
    let mut hello = json!({
        "type": "e2ee-hello", "version": VERSION, "challenge": challenge.challenge(),
        "clientPublicKey": client_public, "proof": "",
    });
    let map = hello.as_object_mut().expect("object");
    for (flag, on) in [("binaryFrames", challenge.flag("binaryFrames")), ("deflate", deflate), ("transportWebrtc", select)] {
        if on {
            map.insert(flag.into(), 1.into());
        }
    }
    for (name, value) in options.hello_fields {
        map.entry(name).or_insert(value);
    }
    let transcript = options.transport.then(|| handshake_transcript(challenge.as_value(), &hello));
    let proof = hello_proof(
        &pairing.pairing_secret,
        challenge.challenge(),
        &pairing.server_public_key,
        &client_public,
        if select { transcript.as_deref() } else { None },
    )?;
    hello["proof"] = proof.into();
    let material = SessionMaterial {
        private: &pair,
        peer_public: &pairing.server_public_key,
        pairing_secret: &pairing.pairing_secret,
        challenge: challenge.challenge(),
        server_public: &pairing.server_public_key,
        client_public: &client_public,
    };
    let key = material.key("key")?;
    let media = if challenge.flag("mediaE2ee") { Some(material.key("media")?) } else { None };
    let transport = if select { Some(transport_keys(&material, Role::Client)?) } else { None };
    let handshake = HandshakeState {
        send: None,
        expect: transcript.map(|t| (t, challenge.flag("transportWebrtc"))),
    };
    Ok((hello, Channel::new(Role::Client, key, deflate, media, transport, handshake)))
}
