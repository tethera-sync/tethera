# Security policy

Before the first public build, add a monitored private reporting address. Do not publicly disclose pairing/auth bypass, path escape, RCE, update bypass, secret/content exposure or crafted-input data loss. Reports should include affected version/platform and redacted reproduction material.

## Local firewall exposure

Tethera listens on UDP 47654 for signed LAN discovery beacons, TCP 47655 for the short-lived pairing handshake and TCP 47656 for authenticated encrypted peer RPC. Firewall rules should be restricted to trusted/private LAN interfaces or the local subnet. Pairing still requires an explicit five-minute visibility window and comparison-code approval on both computers.
