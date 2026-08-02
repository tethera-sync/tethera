# Secure Peer Session and Folder Mapping

Status: implemented development protocol. It is designed for LAN testing and still requires independent security review before public release.

## Purpose

The post-pairing channel lets trusted computers browse destinations, compare selected folders, approve a shared mapping and reconcile mapping-configuration events. Configuration messages do not inspect or modify either mapped folder.

## Authenticated encrypted session

Each request opens a short-lived TCP connection on port `47656`.

1. The initiating computer creates an ephemeral X25519 key and a fresh random nonce.
2. It signs the complete session hello with its persistent paired Ed25519 identity.
3. The receiving computer rejects the hello unless the device ID is trusted, the signature matches the pinned public key, the target identity is exact and the timestamp is fresh.
4. The receiver creates its own ephemeral X25519 key and nonce and signs the complete response.
5. Both computers derive the same session key using X25519, SHA-256 and HKDF.
6. The request and response are encrypted with AES-256-GCM. The session ID, request ID and direction are authenticated as additional data.
7. The connection closes after one request and response, providing a new ephemeral key exchange for every RPC.

The persistent Ed25519 private key never enters the renderer. The React UI only uses the narrow context-isolated preload bridge.

## Allowed peer requests

The server currently accepts only bounded typed operations:

- list directories and standard locations;
- build a read-only file manifest for an explicitly selected folder;
- submit a folder-mapping proposal;
- deliver an approval or rejection for a known proposal;
- deliver a versioned active mapping event or durable mapping tombstone; and
- serve a bounded file for the existing explicitly started development initial pull.

Remote browsing returns folder names, paths, link/directory type and hidden status. It does not return file names or file contents. Creating a folder from the remote browser is disabled; the receiving user may choose or create a different local destination during approval.

## Initial comparison

Before approval, each computer scans its selected folder with the same ignore rules.

- Files up to 16 MiB are SHA-256 hashed in this development slice.
- Larger files use size and close timestamp equality for the preview only.
- The preview is capped at 10,000 files per side.
- It reports local-only, remote-only, identical and different paths.
- It estimates transfer direction and size from the selected sync mode.
- It detects Windows-invalid names and case-only collisions and blocks approval until they are resolved.
- Symlinks are skipped.

The production sync engine will replace this JavaScript preview scanner with Rust, BLAKE3 and resumable content-defined chunking.

## Two-sided mapping approval

The initiator chooses both paths and settings, reviews the comparison, then sends a signed encrypted proposal. The receiver sees a blocking approval dialog and can:

- inspect both paths;
- inspect direction, ignore rules and history limits;
- review comparison counts;
- change the local destination with the custom folder browser;
- approve or reject.

Approval creates the same stable mapping ID on both computers. SQLite commits the responder's configuration before it is presented as durable, then the active event remains in the delivery outbox until the initiator acknowledges its exact mapping ID, event ID and revision. Each side stores its own local path and the opposite path. Send-only and receive-only modes are inverted on the responder so their meaning stays correct locally.

If the receiver changes the destination, Tethera performs a fresh encrypted comparison before approval. The initiator also recomputes its preview immediately before sending the request, and the receiver recomputes once more at approval time. If either folder changed, approval pauses until the refreshed comparison has been reviewed. Preview data supplied by the renderer is therefore never accepted as authoritative.

If the initiator is temporarily unreachable after approval, the receiver retains the active event in SQLite and retries while the peer is online. Duplicate delivery is idempotent.

## Configuration reconciliation and removal

Active mapping records and tombstones use the authenticated peer identity established above. The Rust engine accepts an event only when the authenticated peer and local device are the two mapping participants. It rejects unknown fields and invalid revisions before changing storage.

Ordering uses monotonic revisions with deterministic event IDs; timestamps are diagnostic metadata, not the sole ordering input. A newer event defeats an older active event, and a tombstoned mapping ID is terminal. Re-adding the same folder pair creates a new mapping ID instead of reviving deletion evidence.

Removing a mapping commits its durable tombstone and pending peer delivery in one SQLite transaction. The peer must acknowledge the exact deletion event before the outbox entry is cleared. Disconnects and stale acknowledgements leave it pending. Tombstones survive restart and are not automatically pruned.

## Data-safety boundary

Mapping migration, configuration delivery and removal never scan, copy, replace, rename, move or delete a user file. Removing a mapping changes configuration only and leaves both folders untouched.

The repository separately retains its pre-existing, explicitly initiated development initial pull for bounded remote-only files. That path is not part of configuration reconciliation and is not expanded by the authoritative-mapping work. It still skips files that differ on both sides and is not continuous two-way synchronisation.

## Firewall ports

- UDP `47654`: signed discovery and presence
- TCP `47655`: pairing handshake
- TCP `47656`: authenticated encrypted peer RPC

Rules should be limited to trusted/private LANs. Router port forwarding is not required.
