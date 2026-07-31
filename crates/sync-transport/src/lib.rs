//! LAN/Tailscale transport interfaces.
#![forbid(unsafe_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionRoute {
    LanDirect,
    TailscaleDirect,
    TailscaleRelay,
}
