# Security and threat model

## Goals

Only paired devices access authorised folder metadata/content; traffic is confidential and authenticated; renderer compromise does not expose unrestricted filesystem or identity keys; malformed peers cannot escape roots or exhaust resources; updates are authenticated.

## Out of scope

Plain local files are not protected from malware/admins/unlocked theft/applications with legitimate local access. Full-disk encryption remains recommended. FolderSync encrypts in transit, not ordinary live files at rest.

## Threats and controls

- **Network attacker:** mutual authenticated encryption, replay protection and digest verification.
- **Unpaired peer:** minimal discovery, authenticate before metadata, pairing rate limits and bounded parsers.
- **Revoked peer:** revocation check before every new session and no offline cloud copy.
- **Renderer/XSS:** sandbox, context isolation, no Node integration, strict CSP, local-only content, narrow validated preload API.
- **Path/symlink attack:** component validation, containment checks, no-follow APIs and revalidation at mutation.
- **Resource exhaustion:** quotas, pagination, bounded channels, streaming, timeouts and concurrency limits.
- **Supply chain/update:** lockfiles, dependency review, reproducible CI, signed artefacts, separate signing keys and rotation plan.

## Identity

Generate using OS CSPRNG, store private identity in Windows Credential Manager/Linux Secret Service, never expose it to renderer, display stable fingerprint, and require re-pairing after reinstall.

## Pairing requirements

Single-use expiring secrets, both-device approval, peer name/platform/fingerprint, rate limits, active-substitution resistance and no reusable private secret in QR data.

## Transport

TLS 1.3/reviewed equivalent, ephemeral forward-secret agreement, no anonymous fallback, key pinning to paired identity, modern AEAD and app security even over Tailscale.

## Integrity

BLAKE3 identifies/verifies content; authenticity comes from the secure session. Verify chunks and full file and recheck source/destination revision preconditions before commit.

## Electron checklist

- `nodeIntegration: false`
- `contextIsolation: true`
- renderer sandbox
- strict CSP
- deny arbitrary navigation/popups
- validate sender and arguments
- never open untrusted external URLs
- no remote content
- configure Electron fuses
- stay on supported Electron releases
- run security static analysis in CI

## Local RPC

Owner-only socket/pipe, random per-launch token, fixed schema/method allowlist, no arbitrary execution, independent engine path validation and disconnect on repeated invalid input.

## Archive and logs

Archives are plaintext historical data with owner-only permissions and never peer-exposed as roots. Permanent deletion cannot guarantee physical overwrite on SSD/COW filesystems. Never log file content, pairing secrets, private/session keys or full tokens. Redact absolute roots/usernames in exported bundles.

## Public-beta gates

External pairing/session review, parser fuzzing, path/symlink race tests, update-signature failure tests, dependency scanning, private reporting process and threat-model review on protocol changes.
