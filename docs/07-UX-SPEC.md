# Desktop UX specification

## Direction

A calm utility answering: are devices connected, are folders current, and does anything need attention? Advanced detail remains expandable.

## Navigation

Overview, Folders, Activity, Recovery, Devices, Settings; connection indicator in sidebar footer.

## Overview

Header shows overall status, pause-all, peer and route. Folder cards show name, local/remote paths, status, meaningful progress/speed/current action, pause and details. Avoid idle animation/noise.

## Add-folder wizard

1. Choose local folder.
2. Select paired device.
3. Choose destination on second computer.
4. Direction (two-way default).
5. Trigger (immediate default).
6. Review ignores.
7. Scan both roots.
8. Review initial merge plan.
9. Confirm and start.

## Merge preview

Show unique each side, identical, divergent, incompatible, estimated upload/download and archive space. Start stays disabled until blockers are resolved.

## Folder settings

General; Sync; Ignore rules/tester; Conflicts; History/archive; Network; Compatibility; Notifications; Danger zone. Consequential settings show a preview.

## Activity

Virtualised feed filtered by transfers, changes, conflicts, warnings/errors and ignored. Every entry has a stable explanation and links to affected content when available.

## Ignored items

Search path, filter rule/preset, show exact matching pattern, test paths, edit rules, and preview which items enter/leave sync.

## Recovery

Show durable conflicts and replacement-journal failures first. A two-copy conflict displays both devices, current sizes, modified times and SHA-256 values; only an exact copy allowed by the mapping direction can be selected, and the displaced copy is archived before replacement. Missing-copy conflicts remain read-only. General archive search/grouping, expiry, pinning and permanent deletion are later history-browser work; restore creates a new revision and protects current live content first.

## Devices

Name/platform, fingerprint, last seen, route/latency, Tailscale help, rename and revoke. Explain revocation cannot erase existing remote copies.

## Notifications

Only meaningful failures, low space, incompatibility, auth failure, useful conflict notice and update ready. No routine-success spam.

## Accessibility

Keyboard operation, visible focus, preserve Base UI semantics, never colour-only status, reduced motion, labelled progress, aggregate screen-reader announcements.

## shadcn/Base UI map

Sidebar/navigation, Card/Item, Dialog/Alert Dialog, Sheet, Tabs, Combobox, Field/Input/Select/Switch/Slider, Progress, Tooltip, Toast and Command. Generated code is owned/customised in-repo.

## Pairing prerequisite and folder selection

Folder selection is not available until at least one trusted peer has been paired. Before pairing:

- the top-right primary action is **Pair device**, not **Add folder**;
- the Folders screen explains the protected setup order;
- renderer controls cannot open the add-folder flow;
- the Electron main process rejects direct `folders:add` IPC calls as a second line of defence.

After pairing, adding a mapping uses an in-app browser on both computers rather than a native operating-system dialog. The browser shows only folders, keeps the selected device clearly labelled, supports locations and breadcrumbs, can reveal hidden folders on request, and allows a new destination folder to be created. Remote browsing requires the peer to be online.
