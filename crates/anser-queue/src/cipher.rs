use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde_json::Value;
use zeroize::Zeroizing;

pub struct Cipher(XChaCha20Poly1305);

#[derive(Debug, thiserror::Error)]
#[error("invalid secret encryption data or key")]
pub struct CipherError;

impl Cipher {
    pub fn from_base64(encoded: &str) -> Result<Self, CipherError> {
        let key = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(encoded.trim())
                .map_err(|_| CipherError)?,
        );
        XChaCha20Poly1305::new_from_slice(&key)
            .map(Self)
            .map_err(|_| CipherError)
    }

    pub fn generate_key() -> Zeroizing<String> {
        let mut key = Zeroizing::new([0_u8; 32]);
        rand::rngs::OsRng.fill_bytes(&mut *key);
        Zeroizing::new(URL_SAFE_NO_PAD.encode(key.as_slice()))
    }

    pub fn seal(&self, id: &str, value: &Value) -> Result<Vec<u8>, CipherError> {
        let bytes = Zeroizing::new(serde_json::to_vec(value).map_err(|_| CipherError)?);
        self.seal_bytes(id, &bytes)
    }

    pub fn seal_bytes(&self, id: &str, bytes: &[u8]) -> Result<Vec<u8>, CipherError> {
        let mut nonce = [0; 24];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let ciphertext = self
            .0
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: bytes,
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| CipherError)?;
        let mut result = Vec::with_capacity(25 + ciphertext.len());
        result.push(1);
        result.extend(nonce);
        result.extend(ciphertext);
        Ok(result)
    }

    pub fn open(&self, id: &str, value: &[u8]) -> Result<Value, CipherError> {
        let bytes = self.open_bytes(id, value)?;
        serde_json::from_slice(&bytes).map_err(|_| CipherError)
    }

    pub fn open_bytes(&self, id: &str, value: &[u8]) -> Result<Zeroizing<Vec<u8>>, CipherError> {
        if value.len() < 41 || value[0] != 1 {
            return Err(CipherError);
        }
        Ok(Zeroizing::new(
            self.0
                .decrypt(
                    XNonce::from_slice(&value[1..25]),
                    Payload {
                        msg: &value[25..],
                        aad: id.as_bytes(),
                    },
                )
                .map_err(|_| CipherError)?,
        ))
    }
}
