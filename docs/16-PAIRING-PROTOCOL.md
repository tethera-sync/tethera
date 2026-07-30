# LAN Pairing Protocol — Slices 3–3.2

Status: implemented development protocol. It is suitable for local testing but still requires independent security review before public beta.

## Purpose

Pair two FolderSync installations without an online account or central server. The result is a pinned peer public key stored on each computer. Pairing authorises identity only; every folder mapping still requires separate approval.

## Discovery and presence

Each running installation listens on UDP port `47654` and emits a signed beacon every two seconds.

A beacon contains:

- protocol version;
- stable device ID derived from the Ed25519 public key;
- public key and fingerprint;
- operating-system family;
- fixed TCP pairing port `47655`;
- authenticated peer-session port `47656`;
- whether the five-minute pairing window is active;
- current timestamp;
- Ed25519 signature over the complete beacon body.

The computer name is omitted unless the user explicitly enables pairing visibility. Trusted peers can still recognise an opaque beacon by its pinned device ID.

A device is considered offline after nine seconds without a valid beacon. In addition to LAN broadcast, each installation sends signed beacons directly to addresses learned from valid discovery traffic and trusted pairing sessions. This repairs asymmetric network stacks where one computer receives broadcasts but the other does not.

## Pairing handshake

1. The initiator selects a signed discovery candidate and opens a direct TCP connection on port `47655`.
2. The initiator sends a signed request containing its public identity, a random nonce and the intended target device ID.
3. The responder verifies the request, creates another random nonce and returns a signed challenge.
4. Both computers derive a transcript hash from:
   - session ID;
   - initiator public key;
   - responder public key;
   - initiator nonce;
   - responder nonce.
5. Both display a six-digit comparison code derived from the transcript hash.
6. The initiator confirms that the displayed codes match and sends a signed confirmation.
7. Only after that confirmation does the responder enable its approval button.
8. The responder approves and returns a signed approval bound to the same transcript.
9. Both sides persist the other public identity as trusted.

The comparison code is never sent over the socket. A network attacker replacing either identity or nonce causes the two screens to display different codes.

## Persistence

`pairing-state.json` is stored in Electron's per-user application-data directory. It contains:

- the local Ed25519 private/public identity;
- trusted peer public identities;
- peer names, platforms, fingerprints and pairing timestamps;
- the last authenticated LAN address and peer-session port.

On Linux, the file mode is set to `0600`. A corrupt existing identity file causes pairing startup to fail rather than silently replacing the identity and losing trust relationships.

## Limits and controls

- Pairing visibility expires after five minutes.
- At most five incoming requests may wait at once.
- Handshake stages time out after five minutes.
- An incoming request must target the exact discovered device ID.
- Every protocol message carrying an identity decision is signed.
- Trust removal is local and immediately blocks new authenticated peer sessions.
- A paired peer cannot create a folder mapping without a separate, explicit mapping approval.

## Relationship to Slice 4

The pairing socket is not reused for folder browsing or later file transfer. Slice 4 opens short-lived forward-secret authenticated sessions on TCP `47656`, using the Ed25519 public key pinned by this protocol. See [`17-SECURE-PEER-SESSION-AND-MAPPING.md`](17-SECURE-PEER-SESSION-AND-MAPPING.md).

## Current non-goals

- No file contents are sent through the pairing socket.
- No QR-code pairing is implemented yet.
- No internet discovery or native NAT traversal is implemented yet.
- Tailscale/Headscale routing is planned but not implemented in this slice.

## LAN ports

- UDP `47654`: signed discovery and presence
- TCP `47655`: direct pairing handshake
- TCP `47656`: authenticated encrypted trusted-peer RPC

The fixed ports make private-network firewall configuration predictable. FolderSync does not automatically modify host firewall rules, and router port forwarding is not required for LAN use.
