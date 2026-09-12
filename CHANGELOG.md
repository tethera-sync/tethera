# Changelog

All notable changes to this project, newest first.

- 🐛 Report a bounded list of the files and folders that could not be read, with the total count and a short reason, during folder setup and the initial merge, and let you continue while skipping them or cancel to fix access.
- ✨ Reuse verified file identities across the preview, consent, merge and verification walks so unchanged files are never read twice, label cache-backed steps as reuse instead of another scan, and keep a bounded ledger that makes any duplicate walk visible. Reuse requires a usable file identity and is disabled on FAT/exFAT, where a miss is preferred over an unsafe hit.
- 🎨 Keep dialogs inside the window with internal scrolling and always-reachable actions.
- 🐛 Keep slow folder comparisons running while the other computer reports progress, show its scan activity, and allow cancellation without losing folder selections. Both computers need the update for remote progress.
- ✨ Browse the archived versions kept for each active folder and restore one, with the archive read bounded to the most recent versions.
- 🎨 Show live scan activity and the largest preview differences, with expandable filename warnings.
- 🎨 Use the available width for update progress and folder mappings, with clearer computer and path labels.
