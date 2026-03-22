use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use bip39::{Language, Mnemonic};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    Key, XChaCha20Poly1305, XNonce,
};
use did_ma::{Did, Document, EncryptionKey, SigningKey, VerificationMethod};
use iroh::{Endpoint, EndpointId, endpoint::presets};
use ma_actor_core::{canonical_locale, parse_message_with_locale};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use wasm_bindgen::prelude::*;

// ── Data structures ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct EncryptedIdentityBundle {
    version: u32,
    kdf: String,
    salt_b64: String,
    nonce_b64: String,
    ciphertext_b64: String,
}

#[derive(Serialize, Deserialize)]
struct IdentityBundlePlain {
    version: u32,
    created_at: u64,
    ipns: String,
    signing_private_key_hex: String,
    encryption_private_key_hex: String,
    document: Document,
}

#[derive(Serialize)]
struct CreateResult {
    encrypted_bundle: String,
    did: String,
    ipns: String,
    document_json: String,
}

#[derive(Serialize)]
struct UnlockResult {
    did: String,
    ipns: String,
    document_json: String,
}

#[derive(Serialize)]
struct UpdateResult {
    encrypted_bundle: String,
    did: String,
    ipns: String,
    document_json: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WorldRequest {
    Enter {
        actor_name: String,
        did: String,
        room: Option<String>,
    },
    Message {
        actor_name: String,
        did: String,
        room: String,
        envelope: ma_actor_core::MessageEnvelope,
    },
    RoomEvents {
        room: String,
        since_sequence: u64,
    },
}

#[derive(Serialize, Deserialize)]
struct RoomEvent {
    sequence: u64,
    room: String,
    kind: String,
    sender: Option<String>,
    message: String,
    occurred_at: String,
}

#[derive(Serialize, Deserialize)]
struct WorldResponse {
    ok: bool,
    room: String,
    message: String,
    endpoint_id: String,
    latest_event_sequence: u64,
    broadcasted: bool,
    events: Vec<RoomEvent>,
}

#[derive(Serialize)]
struct WorldActionResult {
    ok: bool,
    room: String,
    message: String,
    endpoint_id: String,
    latest_event_sequence: u64,
    broadcasted: bool,
    events: Vec<RoomEvent>,
}

const WORLD_ALPN: &[u8] = b"ma/world/1";

#[derive(Serialize)]
struct IpnsPointer {
    version: u32,
    identity_bundle_cid: String,
    current_host_hint: String,
    updated_at: u64,
    sequence: u64,
}

// ── Helpers ────────────────────────────────────────────────────────────────────

fn js_err(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn generate_ipns_id() -> Result<String, String> {
    // Produces a k51-style identifier (alphanumeric, 59 chars) compatible with Did::new
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let rand = random_bytes::<56>()?;
    let suffix: String = rand.iter().map(|b| CHARS[(*b as usize) % 36] as char).collect();
    Ok(format!("k51{suffix}"))
}

fn now_unix_secs() -> u64 {
    (js_sys::Date::now() / 1000.0) as u64
}

fn normalize_phrase_text(input: &str) -> String {
    input
        .split_whitespace()
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Crypto ─────────────────────────────────────────────────────────────────────

fn derive_key_argon2(password: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(19456, 2, 1, Some(32)).map_err(|e| format!("argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = [0u8; 32];
    argon2
        .hash_password_into(password, salt, &mut output)
        .map_err(|e| format!("argon2: {e}"))?;
    Ok(output)
}

fn encrypt_bundle(passphrase: &str, plaintext: &[u8]) -> Result<EncryptedIdentityBundle, String> {
    let salt = random_bytes::<16>()?;
    let nonce_bytes = random_bytes::<24>()?;
    let key_bytes = derive_key_argon2(passphrase.as_bytes(), &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key_bytes));
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|e| e.to_string())?;
    Ok(EncryptedIdentityBundle {
        version: 1,
        kdf: "argon2id".to_string(),
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(ciphertext),
    })
}

fn decrypt_bundle(passphrase: &str, bundle: &EncryptedIdentityBundle) -> Result<Vec<u8>, String> {
    let salt = B64.decode(&bundle.salt_b64).map_err(|e| e.to_string())?;
    let nonce_bytes = B64.decode(&bundle.nonce_b64).map_err(|e| e.to_string())?;
    let ciphertext = B64.decode(&bundle.ciphertext_b64).map_err(|e| e.to_string())?;
    let key_bytes = derive_key_argon2(passphrase.as_bytes(), &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key_bytes));
    let nonce = XNonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext.as_slice())
        .map_err(|_| "wrong passphrase or corrupted bundle".to_string())
}

async fn send_world_request(endpoint_id: &str, request: WorldRequest) -> Result<WorldResponse, JsValue> {
    let endpoint_id: EndpointId = endpoint_id
        .trim()
        .parse()
        .map_err(|e| js_err(format!("invalid iroh endpoint id: {e}")))?;

    let endpoint = Endpoint::builder(presets::N0)
        .bind()
        .await
        .map_err(js_err)?;

    let connection = endpoint
        .connect(endpoint_id, WORLD_ALPN)
        .await
        .map_err(|e| js_err(format!("iroh connect failed: {e}")))?;
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|e| js_err(format!("iroh stream open failed: {e}")))?;

    let payload = serde_json::to_vec(&request).map_err(js_err)?;
    send.write_all(&payload)
        .await
        .map_err(|e| js_err(format!("iroh send failed: {e}")))?;
    send.flush()
        .await
        .map_err(|e| js_err(format!("iroh flush failed: {e}")))?;
    send.finish().map_err(js_err)?;

    let response_bytes = recv
        .read_to_end(64 * 1024)
        .await
        .map_err(|e| js_err(format!("iroh read failed: {e}")))?;
    let response: WorldResponse = serde_json::from_slice(&response_bytes).map_err(js_err)?;

    connection.close(0u32.into(), b"ok");
    endpoint.close().await;

    Ok(response)
}

fn restore_signing_key(ipns: &str, private_key_hex: &str) -> Result<SigningKey, JsValue> {
    let sign_did = Did::new(ipns, "sig").map_err(js_err)?;
    let private_key_vec = hex::decode(private_key_hex).map_err(js_err)?;
    let private_key: [u8; 32] = private_key_vec
        .try_into()
        .map_err(|_| js_err("invalid signing private key length"))?;

    SigningKey::from_private_key_bytes(sign_did, private_key).map_err(js_err)
}

fn update_bundle_document<F>(
    passphrase: &str,
    encrypted_bundle_json: &str,
    update: F,
) -> Result<String, JsValue>
where
    F: FnOnce(&mut Document) -> Result<(), JsValue>,
{
    let encrypted: EncryptedIdentityBundle = serde_json::from_str(encrypted_bundle_json)
        .map_err(|e| js_err(format!("invalid bundle JSON: {e}")))?;

    let plain_bytes = decrypt_bundle(passphrase, &encrypted).map_err(js_err)?;
    let mut plain: IdentityBundlePlain = serde_json::from_slice(&plain_bytes)
        .map_err(|e| js_err(format!("bundle corrupted: {e}")))?;

    update(&mut plain.document)?;

    let signing_key = restore_signing_key(&plain.ipns, &plain.signing_private_key_hex)?;
    let assertion_method = plain
        .document
        .get_verification_method_by_id(&plain.document.assertion_method)
        .map_err(js_err)?
        .clone();
    plain.document.sign(&signing_key, &assertion_method).map_err(js_err)?;

    let document_json = plain.document.marshal().map_err(js_err)?;
    let plain_json = serde_json::to_string(&plain).map_err(js_err)?;
    let encrypted = encrypt_bundle(passphrase, plain_json.as_bytes()).map_err(js_err)?;

    let result = UpdateResult {
        encrypted_bundle: serde_json::to_string(&encrypted).map_err(js_err)?,
        did: plain.document.id.clone(),
        ipns: plain.ipns,
        document_json,
    };

    serde_json::to_string(&result).map_err(js_err)
}

// ── Exported WASM functions ────────────────────────────────────────────────────

fn create_identity_internal(passphrase: &str, ipns: &str) -> Result<String, JsValue> {
    let root_did = Did::new_root(ipns).map_err(js_err)?;
    let sign_did = Did::new(ipns, "sig").map_err(js_err)?;
    let enc_did = Did::new(ipns, "enc").map_err(js_err)?;

    let signing_key = SigningKey::generate(sign_did).map_err(js_err)?;
    let encryption_key = EncryptionKey::generate(enc_did).map_err(js_err)?;

    let mut document = Document::new(&root_did, &root_did);

    let assertion_vm = VerificationMethod::new(
        root_did.base_id(),
        root_did.base_id(),
        signing_key.key_type.clone(),
        "sig",
        signing_key.public_key_multibase.clone(),
    )
    .map_err(js_err)?;

    let key_agreement_vm = VerificationMethod::new(
        root_did.base_id(),
        root_did.base_id(),
        encryption_key.key_type.clone(),
        "enc",
        encryption_key.public_key_multibase.clone(),
    )
    .map_err(js_err)?;

    let assertion_vm_id = assertion_vm.id.clone();
    document.add_verification_method(assertion_vm.clone()).map_err(js_err)?;
    document.add_verification_method(key_agreement_vm.clone()).map_err(js_err)?;
    document.assertion_method = assertion_vm_id;
    document.key_agreement = key_agreement_vm.id.clone();
    document.sign(&signing_key, &assertion_vm).map_err(js_err)?;

    let plain = IdentityBundlePlain {
        version: 1,
        created_at: now_unix_secs(),
        ipns: ipns.to_string(),
        signing_private_key_hex: hex::encode(signing_key.private_key_bytes()),
        encryption_private_key_hex: hex::encode(encryption_key.private_key_bytes()),
        document,
    };

    let document_json = plain.document.marshal().map_err(js_err)?;
    let plain_json = serde_json::to_string(&plain).map_err(js_err)?;
    let encrypted = encrypt_bundle(passphrase, plain_json.as_bytes()).map_err(js_err)?;

    let result = CreateResult {
        encrypted_bundle: serde_json::to_string(&encrypted).map_err(js_err)?,
        did: root_did.id(),
        ipns: ipns.to_string(),
        document_json,
    };

    serde_json::to_string(&result).map_err(js_err)
}

/// Generate a new identity, encrypt the bundle with `passphrase`.
/// Returns JSON: `{ encrypted_bundle, did, ipns }`
#[wasm_bindgen]
pub fn create_identity(passphrase: &str) -> Result<String, JsValue> {
    let ipns = generate_ipns_id().map_err(js_err)?;
    create_identity_internal(passphrase, &ipns)
}

/// Generate a new identity bound to an existing IPNS identifier from Kubo.
/// Use this when you already have a Kubo key and want DID/IPNS to match exactly.
#[wasm_bindgen]
pub fn create_identity_with_ipns(passphrase: &str, ipns: &str) -> Result<String, JsValue> {
    let ipns = ipns.trim();
    if ipns.is_empty() {
        return Err(js_err("ipns is required"));
    }
    create_identity_internal(passphrase, ipns)
}

/// Decrypt an encrypted bundle with `passphrase`.
/// Returns JSON: `{ did, ipns, document_json }`
#[wasm_bindgen]
pub fn unlock_identity(passphrase: &str, encrypted_bundle_json: &str) -> Result<String, JsValue> {
    let encrypted: EncryptedIdentityBundle = serde_json::from_str(encrypted_bundle_json)
        .map_err(|e| js_err(format!("invalid bundle JSON: {e}")))?;

    let plain_bytes = decrypt_bundle(passphrase, &encrypted).map_err(js_err)?;

    let plain: IdentityBundlePlain = serde_json::from_slice(&plain_bytes)
        .map_err(|e| js_err(format!("bundle corrupted: {e}")))?;

    let result = UnlockResult {
        did: plain.document.id.clone(),
        ipns: plain.ipns.clone(),
        document_json: plain.document.marshal().map_err(js_err)?,
    };

    serde_json::to_string(&result).map_err(js_err)
}

/// Update the optional `ma:presenceHint` field in the DID document and re-sign it.
/// Returns JSON: `{ encrypted_bundle, did, ipns, document_json }`
#[wasm_bindgen]
pub fn set_bundle_presence_hint(
    passphrase: &str,
    encrypted_bundle_json: &str,
    hint: &str,
) -> Result<String, JsValue> {
    update_bundle_document(passphrase, encrypted_bundle_json, |document| {
        document.set_presence_hint(hint).map_err(js_err)
    })
}

/// Update the optional `ma:locale` field in the DID document and re-sign it.
/// Returns JSON: `{ encrypted_bundle, did, ipns, document_json }`
#[wasm_bindgen]
pub fn set_bundle_locale(
    passphrase: &str,
    encrypted_bundle_json: &str,
    locale: &str,
) -> Result<String, JsValue> {
    update_bundle_document(passphrase, encrypted_bundle_json, |document| {
        document.set_locale(canonical_locale(locale)).map_err(js_err)
    })
}

/// Remove the optional `ma:locale` field from the DID document and re-sign it.
/// Returns JSON: `{ encrypted_bundle, did, ipns, document_json }`
#[wasm_bindgen]
pub fn clear_bundle_locale(
    passphrase: &str,
    encrypted_bundle_json: &str,
) -> Result<String, JsValue> {
    update_bundle_document(passphrase, encrypted_bundle_json, |document| {
        document.clear_locale();
        Ok(())
    })
}

/// Remove the optional `ma:presenceHint` field from the DID document and re-sign it.
/// Returns JSON: `{ encrypted_bundle, did, ipns, document_json }`
#[wasm_bindgen]
pub fn clear_bundle_presence_hint(
    passphrase: &str,
    encrypted_bundle_json: &str,
) -> Result<String, JsValue> {
    update_bundle_document(passphrase, encrypted_bundle_json, |document| {
        document.clear_presence_hint();
        Ok(())
    })
}

/// Enter a world over iroh using the world protocol.
#[wasm_bindgen]
pub async fn enter_world(
    endpoint_id: &str,
    actor_name: &str,
    did: &str,
    room: &str,
) -> Result<String, JsValue> {
    let room = room.trim();
    let response = send_world_request(
        endpoint_id,
        WorldRequest::Enter {
            actor_name: actor_name.trim().to_string(),
            did: did.trim().to_string(),
            room: if room.is_empty() {
                None
            } else {
                Some(room.to_string())
            },
        },
    )
    .await?;

    serde_json::to_string(&WorldActionResult {
        ok: response.ok,
        room: response.room,
        message: response.message,
        endpoint_id: response.endpoint_id,
        latest_event_sequence: response.latest_event_sequence,
        broadcasted: response.broadcasted,
        events: response.events,
    })
    .map_err(js_err)
}

/// Send a room message over iroh using the world protocol.
#[wasm_bindgen]
pub async fn send_world_message(
    endpoint_id: &str,
    actor_name: &str,
    did: &str,
    room: &str,
    locale: &str,
    text: &str,
) -> Result<String, JsValue> {
    let response = send_world_request(
        endpoint_id,
        WorldRequest::Message {
            actor_name: actor_name.trim().to_string(),
            did: did.trim().to_string(),
            room: room.trim().to_string(),
            envelope: parse_message_with_locale(text, canonical_locale(locale)),
        },
    )
    .await?;

    serde_json::to_string(&WorldActionResult {
        ok: response.ok,
        room: response.room,
        message: response.message,
        endpoint_id: response.endpoint_id,
        latest_event_sequence: response.latest_event_sequence,
        broadcasted: response.broadcasted,
        events: response.events,
    })
    .map_err(js_err)
}

/// Poll room events over iroh using the world protocol.
#[wasm_bindgen]
pub async fn poll_world_events(
    endpoint_id: &str,
    room: &str,
    since_sequence: u64,
) -> Result<String, JsValue> {
    let response = send_world_request(
        endpoint_id,
        WorldRequest::RoomEvents {
            room: room.trim().to_string(),
            since_sequence,
        },
    )
    .await?;

    serde_json::to_string(&WorldActionResult {
        ok: response.ok,
        room: response.room,
        message: response.message,
        endpoint_id: response.endpoint_id,
        latest_event_sequence: response.latest_event_sequence,
        broadcasted: response.broadcasted,
        events: response.events,
    })
    .map_err(js_err)
}

/// Build an IPNS pointer record (JSON) for publishing via Kubo or w3s.
/// `sequence` should be the last published sequence; this increments it.
/// Returns pretty-printed JSON of the pointer record.
#[wasm_bindgen]
pub fn build_ipns_pointer(
    ipns: &str,
    bundle_cid: &str,
    host_hint: &str,
    sequence: u32,
) -> Result<String, JsValue> {
    if bundle_cid.is_empty() {
        return Err(js_err("bundle CID is required"));
    }
    let _ = ipns; // included for caller clarity; IPNS name is the key, not stored in value
    let pointer = IpnsPointer {
        version: 1,
        identity_bundle_cid: bundle_cid.to_string(),
        current_host_hint: host_hint.to_string(),
        updated_at: now_unix_secs(),
        sequence: sequence as u64 + 1,
    };
    serde_json::to_string_pretty(&pointer).map_err(js_err)
}

/// Generate a standard BIP39 English mnemonic phrase.
/// Supported word counts: 12, 15, 18, 21, 24.
#[wasm_bindgen]
pub fn generate_bip39_phrase(word_count: u8) -> Result<String, JsValue> {
    let entropy_len = match word_count {
        12 => 16,
        15 => 20,
        18 => 24,
        21 => 28,
        24 => 32,
        _ => return Err(js_err("word_count must be one of 12, 15, 18, 21, 24")),
    };

    let mut entropy = vec![0u8; entropy_len];
    getrandom::getrandom(&mut entropy).map_err(js_err)?;
    let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy).map_err(js_err)?;
    Ok(mnemonic.to_string())
}

/// Normalize and validate a BIP39 English mnemonic phrase.
/// Returns the normalized phrase if valid.
#[wasm_bindgen]
pub fn normalize_bip39_phrase(phrase: &str) -> Result<String, JsValue> {
    let normalized = normalize_phrase_text(phrase);
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized).map_err(js_err)?;
    Ok(mnemonic.to_string())
}
