# Changelog

All notable changes to this project, newest first.

- 🐛 Scan and copy `.asar` files inside synchronized folders (for example packaged Electron apps) instead of reporting them as unreadable.
- 🐛 Merge files that change while the initial merge runs automatically, and only stop, naming the files, if they keep changing.
- 🐛 Show a repeated activity event once with a repeat count, so one recurring failure no longer pushes the rest of the history out of the activity log.
- 🔒 Restrict every desktop action to Tethera's own window, validate folder-browser requests, and reveal folders in the file manager instead of opening them.
- 🔒 Honour each computer's own approved sync direction for continuous sync and stop a cycle when the two computers disagree.
- 🐛 Keep a folder syncing after a file replacement installs but its bookkeeping update fails, instead of blocking that folder until Tethera restarts.
- 🐛 Say when live folder watching is degraded and keep the notice until watching recovers.
- 🐛 Count a folder's files without double-counting identical files or counting paths occupied by folders.
- 🐛 Fix a stuck version-history refresh indicator after the selected folder disappears.
- 🎨 Show an explanation and a Settings link on the Folders screen when the folder configuration is unavailable, instead of a blank page.
- 🎨 Let a folder comparison be cancelled before its first progress update, label every add-folder field for screen readers, and announce comparison phases without re-reading the elapsed timer.
- 🐛 Install Windows updates in place without an installer location prompt and restart Tethera automatically after choosing Restart & update.
- 🎨 Fill the sidebar update icon from the bottom up and show a download progress bar in Settings while an update downloads.
- 🐛 Report a bounded list of the files and folders that could not be read, with the total count and a short reason, during folder setup and the initial merge, and let you continue while skipping them or cancel to fix access.
- ✨ Reuse verified file identities across the preview, consent, merge and verification walks so unchanged files are never read twice, label cache-backed steps as reuse instead of another scan, and keep a bounded ledger that makes any duplicate walk visible. Reuse requires a usable file identity and is disabled on FAT/exFAT, where a miss is preferred over an unsafe hit.
- 🎨 Keep dialogs inside the window with internal scrolling and always-reachable actions.
- 🐛 Keep slow folder comparisons running while the other computer reports progress, show its scan activity, and allow cancellation without losing folder selections. Both computers need the update for remote progress.
- ✨ Browse the archived versions kept for each active folder and restore one, with the archive read bounded to the most recent versions.
- 🎨 Show live scan activity and the largest preview differences, with expandable filename warnings.
- 🎨 Use the available width for update progress and folder mappings, with clearer computer and path labels.
