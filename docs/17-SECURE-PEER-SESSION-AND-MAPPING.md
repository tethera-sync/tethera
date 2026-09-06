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
- deliver a versioned active mapping event or durable mapping tombstone;
- coordinate the inverse pass of an explicitly started initial merge;
- inspect and durably mirror an exact two-copy conflict choice for an active mapping; and
- describe and serve approved mapping-relative files in bounded encrypted chunks.

Pairing/discovery remains protocol version 3. The authenticated peer-session protocol is version 4 because conflict inspection and mirrored winner selection require the same request set on both computers. Older applications are filtered during discovery or rejected during the relevant negotiation rather than silently omitting those checks.

Remote browsing returns folder names, paths, link/directory type and hidden status. It does not return file names or file contents. Creating a folder from the remote browser is disabled; the receiving user may choose or create a different local destination during approval.

## Initial comparison

Before approval, each computer scans its selected folder with the same ignore rules.

- Files up to 16 MiB are SHA-256 hashed in this development slice.
- Larger files use size and close timestamp equality for the preview only.
- The preview is capped at the scanning computer's configured scan-file limit (10,000 files by default) per side.
- It reports local-only, remote-only, identical and different paths.
- It estimates additive transfer direction and size from the selected sync mode; same-path differences are excluded because this slice leaves them untouched.
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

## Coordinated initial merge

After approval, either user may start the initial merge. The lower participant device id coordinates deterministically, forwarding the command when it was clicked on the other computer. It obtains and heartbeats a short-lived mapping-scoped lease from the peer before any full scan or file read; file operations are serialized, and pause/removal is rejected on both computers until the lease is released or expires. The coordinator performs its allowed pull first, then asks the authenticated peer to run the inverse pull. Send-only and receive-only modes are already inverted in the peer's local mapping, so the two passes honor the selected direction without a separate upload endpoint. A fresh two-sided full-integrity scan must show no remaining transferable one-sided files before activation; if either folder changed, Tethera leaves copied files in place and asks the user to retry. Completion is reported only after the peer acknowledges the exact active mapping event.

The transfer scan hashes every file, including files above the preview hashing ceiling. A scan that exceeds the configured file limit or encounters unreadable items fails instead of presenting an incomplete merge as complete; the error names the limit so the user can raise it in Settings or add ignore rules and retry. Files missing at a destination are transferred in 512 KiB requests. The source returns a full SHA-256 descriptor and serves each range only while size and modification time remain stable. The destination verifies the complete size and digest, fsyncs a sibling staging file, rejects symlink escapes, and atomically links the completed file into place only if the destination still does not exist.

Same-path differences are never overwritten in this milestone. They remain unchanged on both computers and are persisted as structured outcomes for restart-safe folder status as well as activity. No deletion or rename is propagated. If the connection closes, an incomplete staging file is removed; power-loss residue uses a reserved staging name that manifest scans never synchronize. Retry re-scans both sides and treats previously committed files as already identical.

## Continuous reconciliation

After activation, only the deterministic lower device ID coordinates reconciliation. Both participants watch their approved root; native directory notifications trigger a debounced local cycle or an authenticated notification to the coordinator. A five-minute full verification catches missed events. The authenticated peer accepts full scans and file operations only for the exact active, unpaused mapping and its elected coordinator. Ignore rules and reserved staging names are enforced on file reads.

Both full SHA-256 manifests are reconciled in Rust against a durable common baseline. A new file or a file changed on only one computer becomes a durable directional operation when the mapping mode permits it. Existing destinations are committed only while they still match the expected baseline digest. The receiving device binds the request to its durable pull operation, moves the exact destination entry aside, copies and verifies it in the external content-addressed archive, and records the archive journal before installing the staged replacement. Successful writes update the baseline and journal together. Failed or interrupted operations retain bounded diagnostics and explicit recovery state for restart/reconnect reconciliation.

The first scan marks a mapping observed but never guesses about one-sided legacy files. Simultaneous edits, one-sided deletions, blocked-direction changes, and unbased divergent paths become durable conflicts. The UI reports their paths and states explicitly. For two present copies, the user may choose one only after both authenticated participants freshly verify the device-bound digests and sizes the renderer displayed; the exact mirrored choice is durable on both computers before transfer, acknowledgements name its operation ID, and the receiving side archives its displaced copy through the normal replacement journal. Tethera does not pick a newest timestamp or delete either copy. Missing-copy conflicts remain untouched, and unresolved replacement recovery evidence blocks later reconciliation.

## Configuration reconciliation and removal

Active mapping records and tombstones use the authenticated peer identity established above. The Rust engine accepts an event only when the authenticated peer and local device are the two mapping participants. It rejects unknown fields and invalid revisions before changing storage.

Ordering uses monotonic revisions with deterministic event IDs; timestamps are diagnostic metadata, not the sole ordering input. A newer event defeats an older active event, and a tombstoned mapping ID is terminal. Re-adding the same folder pair creates a new mapping ID instead of reviving deletion evidence.

Removing a mapping commits its durable tombstone and pending peer delivery in one SQLite transaction. The peer must acknowledge the exact deletion event before the outbox entry is cleared. Disconnects and stale acknowledgements leave it pending. Tombstones survive restart and are not automatically pruned.

## Data-safety boundary

Mapping migration, configuration delivery and removal never scan, copy, replace, rename, move or delete a user file. Removing a mapping changes configuration only and leaves both folders untouched.

File scanning, watch scheduling, and encrypted chunk transport remain Electron-owned; Rust owns the durable reconciliation decision and file-sync metadata. There is no deletion/rename propagation, conflict winner, recovery browser/retention policy, mid-file resume, or bandwidth scheduler.

## Firewall ports

- UDP `47654`: signed discovery and presence
- TCP `47655`: pairing handshake
- TCP `47656`: authenticated encrypted peer RPC

Rules should be limited to trusted/private LANs. Router port forwarding is not required.
