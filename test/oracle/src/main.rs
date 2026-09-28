//! Emits deterministic crypto test vectors (JSON on stdout) using the same crates
//! and call patterns as upstream onchainos (cli/src/crypto.rs, file_keyring.rs).
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use alloy_primitives::{Address, B256, U256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{eip712_domain, sol, SolStruct};
use base64::Engine;
use rand::{rngs::StdRng, RngCore, SeedableRng};
use serde_json::{json, Value};
use tiny_keccak::{Hasher, Keccak};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

sol! {
    struct TransferWithAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }
}

fn keccak(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

fn secp_sign(key: &[u8; 32], hash: &[u8; 32]) -> Vec<u8> {
    let signer = PrivateKeySigner::from_slice(key).unwrap();
    let sig = signer.sign_hash_sync(&B256::from(*hash)).unwrap();
    let mut out = Vec::with_capacity(65);
    out.extend_from_slice(&sig.r().to_be_bytes::<32>());
    out.extend_from_slice(&sig.s().to_be_bytes::<32>());
    let v = sig.v() as u8;
    out.push(if v < 27 { v } else { v - 27 });
    out
}

fn main() {
    let mut rng = StdRng::seed_from_u64(0x0c1);
    let mut out = serde_json::Map::new();

    // keccak
    let mut kv = vec![];
    for len in [0usize, 1, 3, 135, 136, 137, 300] {
        let mut m = vec![0u8; len];
        rng.fill_bytes(&mut m);
        kv.push(json!({"msg": hex::encode(&m), "hash": hex::encode(keccak(&m))}));
    }
    out.insert("keccak256".into(), Value::Array(kv));

    // secp256k1 recoverable signatures (alloy PrivateKeySigner, as crypto.rs::secp256k1_sign)
    let mut sv = vec![];
    for _ in 0..8 {
        let mut k = [0u8; 32];
        let mut h = [0u8; 32];
        rng.fill_bytes(&mut k);
        rng.fill_bytes(&mut h);
        let signer = PrivateKeySigner::from_slice(&k).unwrap();
        sv.push(json!({"key": hex::encode(k), "hash": hex::encode(h), "sig": hex::encode(secp_sign(&k, &h)), "address": format!("{:#x}", signer.address())}));
    }
    out.insert("secp256k1".into(), Value::Array(sv));

    // ed25519 (crypto.rs::ed25519_sign)
    let mut ev = vec![];
    for len in [0usize, 32, 100] {
        let mut seed = [0u8; 32];
        rng.fill_bytes(&mut seed);
        let mut m = vec![0u8; len];
        rng.fill_bytes(&mut m);
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        use ed25519_dalek::Signer;
        ev.push(json!({"seed": hex::encode(seed), "msg": hex::encode(&m), "sig": hex::encode(sk.sign(&m).to_bytes()), "pub": hex::encode(sk.verifying_key().to_bytes())}));
    }
    out.insert("ed25519".into(), Value::Array(ev));

    // x25519 public keys
    let mut xv = vec![];
    for _ in 0..3 {
        let mut s = [0u8; 32];
        rng.fill_bytes(&mut s);
        let secret = x25519_dalek::StaticSecret::from(s);
        xv.push(json!({"secret": hex::encode(s), "pub": hex::encode(x25519_dalek::PublicKey::from(&secret).as_bytes())}));
    }
    out.insert("x25519".into(), Value::Array(xv));

    // HPKE single-shot seal, suite used by crypto.rs::hpke_decrypt_session_sk
    {
        use hpke::{aead::AesGcm256, kdf::HkdfSha256, kem::X25519HkdfSha256, single_shot_seal, Kem, OpModeS, Serializable};
        let mut hv = vec![];
        for _ in 0..3 {
            let (sk_r, pk_r) = X25519HkdfSha256::gen_keypair(&mut rng);
            let mut seed = [0u8; 32];
            rng.fill_bytes(&mut seed);
            let (enc, ct) = single_shot_seal::<AesGcm256, HkdfSha256, X25519HkdfSha256, _>(
                &OpModeS::Base, &pk_r, b"okx-tee-sign", &seed, &[], &mut rng,
            ).unwrap();
            let mut payload = enc.to_bytes().to_vec();
            payload.extend_from_slice(&ct);
            hv.push(json!({
                "session_key_b64": B64.encode(sk_r.to_bytes()),
                "encrypted_b64": B64.encode(&payload),
                "seed": hex::encode(seed),
            }));
        }
        out.insert("hpke".into(), Value::Array(hv));
    }

    // file_keyring: scrypt(logN=15,r=8,p=1,32) -> AES-256-GCM; file = salt(32)||nonce(12)||ct
    {
        let identity = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let mut salt = [0u8; 32];
        let mut nonce = [0u8; 12];
        rng.fill_bytes(&mut salt);
        rng.fill_bytes(&mut nonce);
        let params = scrypt::Params::new(15, 8, 1, 32).unwrap();
        let mut key = [0u8; 32];
        scrypt::scrypt(identity.as_bytes(), &salt, &params, &mut key).unwrap();
        let plaintext = br#"{"access_token":"a.b.c","refresh_token":"d.e.f"}"#;
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ct = cipher.encrypt(Nonce::from_slice(&nonce), plaintext.as_ref()).unwrap();
        let mut file = salt.to_vec();
        file.extend_from_slice(&nonce);
        file.extend_from_slice(&ct);
        out.insert("keyring".into(), json!({"identity": identity, "file": hex::encode(file), "plaintext": String::from_utf8_lossy(plaintext)}));
    }

    // EIP-3009 / EIP-712 (crypto.rs::eip3009_sign)
    {
        let key = hex::decode("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").unwrap();
        let auth = TransferWithAuthorization {
            from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266".parse::<Address>().unwrap(),
            to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8".parse::<Address>().unwrap(),
            value: U256::from(1_000_000u64),
            validAfter: U256::from(0u64),
            validBefore: U256::from(1_900_000_000u64),
            nonce: B256::from([0x11u8; 32]),
        };
        let domain = eip712_domain! {
            name: "USD Coin".to_string(),
            version: "2".to_string(),
            chain_id: 196u64,
            verifying_contract: "0x74b7F16337b8972027F6196A17a631aC6dE26d22".parse::<Address>().unwrap(),
        };
        let hash = auth.eip712_signing_hash(&domain);
        let mut k = [0u8; 32];
        k.copy_from_slice(&key);
        let mut sig = secp_sign(&k, &hash.0);
        sig[64] += 27;
        out.insert("eip3009".into(), json!({
            "key": hex::encode(&key), "chainId": 196, "name": "USD Coin", "version": "2",
            "verifyingContract": "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
            "from": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "to": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "value": "1000000", "validAfter": "0", "validBefore": "1900000000", "nonce": format!("0x{}", hex::encode([0x11u8; 32])),
            "hash": hex::encode(hash.0), "sig_b64": B64.encode(&sig),
        }));
    }

    // base58
    let mut bv = vec![];
    for len in [0usize, 1, 32, 64] {
        let mut m = vec![0u8; len];
        rng.fill_bytes(&mut m);
        if len == 32 { m[0] = 0; m[1] = 0; }
        bv.push(json!({"hex": hex::encode(&m), "b58": bs58::encode(&m).into_string()}));
    }
    out.insert("base58".into(), Value::Array(bv));

    println!("{}", serde_json::to_string_pretty(&Value::Object(out)).unwrap());
}
