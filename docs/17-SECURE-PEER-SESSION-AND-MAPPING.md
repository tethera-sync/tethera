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
6. The request and response are encrypted with AES-256-GCM. The session ID, request ID and direction are authenticated as additional data. Every frame carries a 12-byte IV and a full 16-byte authentication tag; any other length, or a non-string sealed field, is rejected before decryption, because Node would otherwise verify a truncated tag prefix.
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
- describe and serve approved mapping-relative files in bounded encrypted chunks;
- advertise the `scan-generations-v1` capability and serve bounded pages of a sealed staged scan generation to either mapping participant.

Each encrypted frame remains capped at 16 MiB. Parsed inbound messages are additionally bounded to 32 queued messages and 4 MiB while a handler runs; overflow closes the connection and terminal state clears retained buffers and queues. Peer request handlers expose a socket-close/deadline abort signal that cooperative scans thread to their next checkpoint.

Messages larger than one frame use `secure-chunk` frames between peers that both advertise `chunked-frames-v1` through `scan-capabilities`. A requester that knows the peer supports them sends its request as chunks, even when one chunk suffices, and the responder answers a chunked request with a chunked terminal response; scan progress envelopes stay single frames. Each chunk carries at most 1 MiB of plaintext with its own random 12-byte IV and full 16-byte tag, and binds the session ID, request ID, direction, chunk index, chunk count and total size as additional data. The receiver authenticates the first chunk before sizing any buffer from the total it claims, then requires every chunk in order, repeating the same count and total, with exactly the length the sender's split produces; one message is capped at 256 MiB of JSON. A session carries one request and one response, so no two chunked messages ever share a session, request ID and direction, and a chunk cannot move between messages. Senders honour socket backpressure rather than buffering a whole message. Older peers never receive chunk frames and keep the single-frame limits.

Pairing/discovery remains protocol version 3. The authenticated peer-session protocol is version 4 because conflict inspection and mirrored winner selection require the same request set on both computers. Older applications are filtered during discovery or rejected during the relevant negotiation rather than silently omitting those checks.

Remote browsing returns folder names, paths, link/directory type and hidden status. It does not return file names or file contents. Creating a folder from the remote browser is disabled; the receiving user may choose or create a different local destination during approval.

## Initial comparison

Before approval, each computer scans its selected folder with the same ignore rules.

Before requesting a preview scan, or an initial-merge or convergence `scan-manifest` with `hashAllFiles`, the requester negotiates `scan-progress-v1` through `scan-capabilities`. Supporting peers opt in with `scan-manifest.reportProgress: true`; only these requests receive intermediate encrypted response frames containing `{ progress, sequence }` before the terminal `{ ok, result/error }` response. Frames use the same authenticated request correlation, response direction and independent random IVs. Sequence numbers start at one and must be contiguous. Progress contains only stage and nonnegative safe-integer file/byte counters, never paths or contents. Envelopes are limited to 4 KiB and 8,000 messages, with sends throttled to four per second and dropped while the socket is backpressured. They are advisory and cannot authorize a mapping or replace a manifest.

The secure welcome has a ten-second timeout. Peer scans have no time limit: a scan runs as long as its folder needs, reporting bounded authenticated counters throughout when both computers support progress. A closed connection, or failed TCP keepalive when the other computer disappears silently, ends the wait. Memory stays bounded by the scan budget and frame limits rather than by elapsed time. Disconnect or preview cancellation aborts queued/active cooperative scans; an OS filesystem operation already in progress may need to return before its slot can be released. The dialog offers cancellation while scanning, keeps the selected paths after failure, and displays remote activity when available.

Older version-4 peers that lack this capability retain the single-response five-minute preview request. Both installations must be updated for progress-aware comparisons. A peer that predates capability discovery is recognized only by its exact unsupported-operation error; malformed capability responses and transport failures do not trigger fallback. No protocol-version bump is needed because intermediate frames require explicit opt-in after capability discovery.

- Files up to 16 MiB are SHA-256 hashed in this development slice.
- Larger files use size and close timestamp equality for the preview only.
- The preview has no file-count limit. It is bounded by the 256 MiB chunked exchange between updated peers or the 16 MiB frame with an older peer; an older peer may still stop at its own scan-file limit and mark its scan truncated.
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

After approval, either user may start the initial merge. The lower participant device id coordinates deterministically, forwarding the command when it was clicked on the other computer. It obtains and heartbeats a short-lived mapping-scoped lease from the peer before any full scan or file read; file operations are serialized, and pause/removal is rejected on both computers until the lease is released or expires. The coordinator performs its allowed pull first, then asks the authenticated peer to run the inverse pull. Before its first copy, the coordinator checks that its planned additions fit on its disk with 1 GiB kept spare and, when the peer advertises `initial-merge-free-space-v1`, sends the lease-bound `initial-sync-free-space` request and checks the inverse pass against the returned `{ availableBytes }` the same way; the inverse pass repeats its own local check against a fresh plan. A forwarded start that fails receives the coordinator's failure reason, not only its status line. The inverse pull, and a forwarded start waiting on the coordinator, have no fixed response deadline, so a large transfer runs as long as it needs; TCP keepalive on peer sockets fails the wait if the other computer disappears without closing the connection. Send-only and receive-only modes are already inverted in the peer's local mapping, so the two passes honor the selected direction without a separate upload endpoint. A fresh two-sided full-integrity scan must show no remaining transferable one-sided files before activation; if either folder changed, both passes run again from fresh scans, up to three attempts, before Tethera stops and names the files that kept changing; copied files stay in place. Completion is reported only after the peer acknowledges the exact active mapping event.

Between computers that both advertise `initial-merge-generations-v1`, a merge pass stages both scans as sealed generations instead: the coordinator requests the peer's with the lease-gated `initial-sync-generation-scan`, fetches its pages, and asks the engine for a read-only additive plan. The peer's bounded inaccessible-path report travels with its scan reply, so the coordinator reviews both computers' items together. The coordinator then passes the accepted report's signature to the peer's inverse pass, which proceeds only when its own fresh scan matches that exact report; anything newly inaccessible stops that pass for review instead of being skipped silently. The merge's additive plan is the only place a one-sided file can become a copy, so the same lease, direction, participant, revision and path-scope checks apply; a peer without the capability keeps the full-manifest merge unchanged. This channel never propagates deletion or rename.

The transfer scan hashes every file, including files above the preview hashing ceiling. Scans have no file-count limit. A scan that encounters unreadable items fails instead of presenting an incomplete merge as complete (the initial merge first lets the user review and skip them). A truncated scan, which only an older peer still produces at its own scan-file limit, fails closed and asks the user to update both computers. Between peers that both advertise `chunked-frames-v1`, a manifest or observation larger than one frame crosses the channel as authenticated chunks, bounded exactly at 256 MiB of JSON per exchange. With an older peer, full-manifest scans still fail closed above an estimated 12 MiB encrypted response (headroom below the 16 MiB frame cap), and a continuous cycle refuses an observe exchange that would not fit before reconciling; the error explains the limit instead of silently trimming a complete observation. Files missing at a destination are transferred in 512 KiB requests. The source returns a full SHA-256 descriptor and serves each range only while size and modification time remain stable. A requester that sends `reportUnavailable: true` with `pull-file-descriptor` or `pull-file-chunk` receives `{ unavailable: true }` when that one file was removed, retyped or changed at the source, and leaves it out; a path resolving outside the folder or a missing folder root still fails the request, and an older source ignores the flag and fails it as before. The destination verifies the complete size and digest, fsyncs a sibling staging file, rejects symlink escapes, and atomically links the completed file into place only if the destination still does not exist. A manifest may also carry `occupiedPaths`: symbolic links, special entries (`special`, blocking the path and everything beneath it) and folders holding no synchronized file (`directory`, blocking only that exact path). Neither computer plans a copy onto a path the other reports as occupied; the receiver validates the list strictly, and a peer that omits it is treated as reporting none.

Same-path differences are never overwritten in this milestone. They remain unchanged on both computers and are persisted as structured outcomes for restart-safe folder status as well as activity. No deletion or rename is propagated. If the connection closes, an incomplete staging file is removed; power-loss residue uses a reserved staging name that manifest scans never synchronize. Retry re-scans both sides and treats previously committed files as already identical.

## Continuous reconciliation

After activation, only the deterministic lower device ID coordinates reconciliation. Both participants watch their approved root; native directory notifications trigger a debounced local cycle or an authenticated notification to the coordinator. A five-minute full verification catches missed events. The authenticated peer accepts full scans and file operations only for the exact active, unpaused mapping and its elected coordinator. Ignore rules and reserved staging names are enforced on file reads.

When both computers advertise `continuous-fingerprint-v1`, the coordinator may add `knownFingerprint` to `continuous-sync-scan`: the fingerprint of the peer's observation at the last reconcile that queued nothing. The peer computes its own fingerprint with a streaming full-integrity scan and answers `{ unchanged: true }` only when it matches, the scan was complete, and the peer has no pending operations or recovery issues; otherwise it returns its full manifest as before. A malformed fingerprint is treated as absent, never as a match.

Both full SHA-256 manifests are reconciled in Rust against a durable common baseline. A new file or a file changed on only one computer becomes a durable directional operation when the mapping mode permits it. Existing destinations are committed only while they still match the expected baseline digest. The receiving device binds the request to its durable pull operation, moves the exact destination entry aside, copies and verifies it in the external content-addressed archive, and records the archive journal before installing the staged replacement. Successful writes update the baseline and journal together. Failed or interrupted operations retain bounded diagnostics and explicit recovery state for restart/reconnect reconciliation.

Sealed staged generations offer the bounded alternative to legacy full manifests: `scan-capabilities` negotiates `scan-generations-v1`, and `scan-generation-read-page` serves at most 1,000 entries (and 1 MiB) per page from a sealed generation bound to the same mapping, revision, and participants. Either authenticated mapping participant may read a sealed generation of their shared mapping — one side fetches the other's observation during the exchange — while starting a scan stays coordinator-only. An approved mapping whose initial merge is still running is covered by the same participant rule, gated by the in-flight merge or its active lease, because the merge fetches the same way. A changed continuous cycle takes this path only when both peers advertise `chunked-frames-v1` as well, because the reconciliation state returned by the observe exchange can exceed one frame; peers without it keep the full-manifest exchange. Legacy peers without the capability retain the explicit legacy limits above. Generation reconciliation applies the mapping's ignore rules, streams ordered pages with backpressure and cancellation, requires full SHA-256 digests with pre-transfer revalidation, reports occupied destinations instead of queuing transfers that could only fail, and never lets an incomplete generation affect baselines or planning. `scanGeneration.release` deletes a finished generation in any state; aborted, crashed or expired rows are removed by `scanGeneration.cleanup`, which the desktop calls at engine start, after a failed generation cycle, and when an initial merge ends.

The first scan marks a mapping observed but never guesses about one-sided legacy files. Simultaneous edits, one-sided deletions, blocked-direction changes, and unbased divergent paths become durable conflicts. The UI reports their paths and states explicitly. For two present copies, the user may choose one only after both authenticated participants freshly verify the device-bound digests and sizes the renderer displayed; the exact mirrored choice is durable on both computers before transfer, acknowledgements name its operation ID, and the receiving side archives its displaced copy through the normal replacement journal. Tethera does not pick a newest timestamp or delete either copy. Missing-copy conflicts remain untouched, and unresolved replacement recovery evidence blocks later reconciliation.

## Configuration reconciliation and removal

Active mapping records and tombstones use the authenticated peer identity established above. The Rust engine accepts an event only when the authenticated peer and local device are the two mapping participants. It rejects unknown fields and invalid revisions before changing storage.

Ordering uses monotonic revisions with deterministic event IDs; timestamps are diagnostic metadata, not the sole ordering input. A newer event defeats an older active event, and a tombstoned mapping ID is terminal. Re-adding the same folder pair creates a new mapping ID instead of reviving deletion evidence.

Either user may edit an existing mapping's name, sync direction, ignore rules and version-history limits. The edit is a new revision delivered like a pause. Approval is each computer's consent to what leaves its folder, so an edit may narrow what the other computer shares but never widen it: it cannot make the other computer start sending, remove or rewrite an ignore rule while the other computer sends, or move either folder. The editing computer refuses such a change, and the receiving computer independently rejects it before applying the event; widening requires removing the mapping and requesting approval again. Stale and duplicate events are left to the engine's ordering. During a continuous cycle the coordinator sends its ignore rules with `continuous-sync-observe`, and the peer fails the cycle closed while the two rule sets differ; older coordinators omit the field.

Removing a mapping commits its durable tombstone and pending peer delivery in one SQLite transaction. The peer must acknowledge the exact deletion event before the outbox entry is cleared. Disconnects and stale acknowledgements leave it pending. Tombstones survive restart and are not automatically pruned.

## Data-safety boundary

Mapping migration, configuration delivery and removal never scan, copy, replace, rename, move or delete a user file. Removing a mapping changes configuration only and leaves both folders untouched.

File scanning, watch scheduling, and encrypted chunk transport remain Electron-owned; Rust owns the durable reconciliation decision and file-sync metadata. There is no deletion/rename propagation, conflict winner, recovery browser/retention policy, mid-file resume, or bandwidth scheduler.

## Firewall ports

- UDP `47654`: signed discovery and presence
- TCP `47655`: pairing handshake
- TCP `47656`: authenticated encrypted peer RPC

Rules should be limited to trusted/private LANs. Router port forwarding is not required.
