//! Identity/pairing boundary; no placeholder cryptography.
#![forbid(unsafe_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicDeviceIdentity {
    pub device_id: String,
    pub public_key: Vec<u8>,
    pub fingerprint: String,
}
