# Network and protocol specification

## Connectivity order

1. Direct LAN via mDNS/UDP discovery.
2. Direct Tailscale address/MagicDNS.
3. Tailscale relay when direct is unavailable.
4. Advanced manual endpoint, disabled by default.

Normal use requires no public inbound port and never uses Tailscale Funnel. Application-layer authenticated encryption is mandatory on every route.

## Discovery privacy

Advertise only protocol versions, ephemeral discovery ID and listening port. Never broadcast folder names, usernames or file metadata. Tailscale support should use local client information and not depend on hosted admin APIs, allowing Headscale-backed clients where ordinary peer connectivity works.

## Pairing

### Discovered peer
Select peer, establish ephemeral pairing channel, show the same SAS/fingerprint on both screens, approve on both, then store long-term public trust.

### One-time code
Generate a high-entropy, expiring, single-use code bound to a selected LAN/Tailscale endpoint through an audited PAKE/equivalent. Rate-limit attempts and still require both-screen SAS approval. The code is not a global locator because the project has no rendezvous service.

### QR
Versioned URI containing endpoint candidates, ephemeral public data and expiry; never long-term private material.

## Session target

- Persistent Ed25519 device identity.
- Ephemeral X25519 agreement.
- TLS 1.3 or reviewed Noise construction through audited Rust libraries.
- Mutual authentication pinned to paired identity.
- Forward secrecy, replay resistance and key confirmation.

The final suite requires focused review before public beta; no bespoke primitives.

## Framing

Frames contain version, type, operation/request ID, bounded payload length and payload within the authenticated encrypted channel. Reject oversized/deep inputs before allocation.

## Capability negotiation

Exchange protocol range, digests/chunk algorithms, path/metadata capabilities, frame limits, compression, resume and authorised folder IDs. Major incompatibility refuses sync; minor capabilities are additive.

## Message families

```text
SessionHello / SessionAccepted
PairRequest / PairProof / PairApproved
FolderOffer / FolderAccepted / FolderRevoked
StateSummary / EntryInventoryPage
RevisionOffer / RevisionNeed / RevisionReject
ChunkMap / ChunkNeed / ChunkData / ChunkAck
WholeFileStart / WholeFileData / WholeFileFinish
RenameOffer / DeleteOffer
OperationCommitted / OperationFailed
Ping / Pong / Goodbye
```

## Inventory

Page large inventories using stable ordering/generation cursors, allow subtree reconciliation and treat peer metadata as untrusted. Add Merkle subtree summaries only after basic paged correctness.

## Chunking

Content-defined, deterministic, bounded chunks with BLAKE3 per chunk/full file. Example benchmark target: 256 KiB minimum, 1 MiB average, 8 MiB maximum. Chunks are accessible only within an authorised operation.

## Resume

Transfer ID binds peer, folder, revision, destination, digest/size and chunk plan. Resume only verified chunks and refuse if source/policy/temp state changed.

## Compression and limits

Avoid compressing media/archive formats. Bound decompression output. Use token-bucket limits globally/per folder, prioritise control frames, support pause/full-speed and metered policies.

## UI route states

`LAN direct`, `Tailscale direct`, `Tailscale relay`, `Connecting`, `Offline`, `Authentication failed`, `Version incompatible`.
