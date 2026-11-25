# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[简体中文](./CHANGELOG_zh.md)

## [Unreleased]

### Added

- Trash rows now show a compact monospace session ID with the full ID on hover and one-click copying. Clipboard failures show a readable reason and select the full ID in a read-only field for manual copying. English/Chinese feedback, full IDs (including `im-link:` IDs), fallback, timed confirmation and unmount cleanup are covered by Client regressions; Host APIs and deletion behavior are unchanged.

### Changed

- Documentation: the Windows GUI delete flow is recorded as maintainer-verified on 2026-11-25 (install, sidebar entry, Move to Trash, Restore, Delete forever and Empty Trash on native Windows). The six Windows-only native regression cases and the rc.2 Desktop GUI remain unrun; the compatibility tables, plan and project notes state that boundary.

### Changed

- The changelog is now bilingual: `CHANGELOG.md` (English) and `CHANGELOG_zh.md` (简体中文) are maintained as one record with matching structure and order. Every change must add an `[Unreleased]` entry to both files; the release checklist (version bump, tag, GitHub Release) is recorded in `AGENTS.md`.

## [0.2.0] - 2026-11-25

Windows support, deferred deletion for sessions DSH keeps loaded, audit-log
rotation, a Client cleanup notification so deleted conversations stop
reappearing under Ungrouped, and DSH 0.2.2-rc.2 compatibility.

### Fixed

- Successful physical deletion and ghost cleanup now best-effort emit the public `api-session/removed(sessionId)` event after marker removal, clearing stale Client catalog rows that could reappear under Ungrouped. Failed/deferred deletion and staging-only recovery never notify; listener exceptions record `removed/warning` without changing successful results or Empty Trash counts. Added 14 synthetic-home boundary regressions and installed rc.5 Host Gateway → Client event pump/catalog → Workspace tree reproductions (row present before delivery, absent afterward; failure/queue retain it). Notifications remain non-replayed best effort; no core/profile changes or real-session acceptance.
- Busy session write leases carry the stable `[D_TRASH_SESSION_LOCK_BUSY] ` prefix in underlying lock errors. The deferred-deletion workflow below supersedes the earlier manual restart/retry advice and counting busy sessions as failures. Audit unlock reporting explicitly requires an acquired, successfully released lease; real-lease/audit and exact-prefix Client regressions verify this boundary.
- Delete/empty now cleans ghost records re-created from stale Client lists when the first persistence `stat` explicitly returns `undefined` and marker/archive gates pass. Cleanup skips log deletion, records `logs-absent`, detaches current owners, unarchives, removes the marker, and attempts projection cleanup using a validated home. Thrown stat errors (including I/O failures), unreliable snapshots, and missing locations during later locked rechecks still refuse cleanup. Existing purge receipt validation/recovery is preserved. Added isolated ghost, refusal, interleaving, and recovery regressions for Node and installed Electron discovery.

### Added

- Deferred deletion for lock-busy sessions: private marker `deferredAt`, stable `[D_TRASH_DEFERRED] ` queue acknowledgements, bilingual pending/status UI, and Restore cancellation that keeps ordinary Trash state. Background Host startup maintenance retries through the existing purge gates and write leases; still-busy sessions remain queued, readiness failures retry with backoff, and purge receipts remain separate. Audit adds `deferred` and `startup`; Empty Trash distinguishes deleted, failed, and queued counts. Synthetic-home and Client regressions cover restart, cancellation, readiness, failures, receipts, and summaries.
- Size-based audit rotation with fixed 4 MiB / three-archive retention, rotation records, safe file validation, and best-effort logger fallback. Added threshold, eviction, exact-line retention, failure/retry, concurrent rotation, and late old-handle regressions.
- Windows write exclusion compatible with JSONL's named kernel semaphore via Koffi 3.1.1, without requiring `session.lock`.
- Bounded Windows sharing-violation retries with identity/archive checks and durable retry receipts; explicit platform test skips and cross-platform discovery launcher.
- Packed rc.2/rc.5 API and isolated build/test compatibility matrix, official-lease interoperability probes, and Windows self-check instructions.

### Changed

- DSH peer lower bound is now `^0.2.2-rc.2`; development versions remain pinned to rc.5. No rc.2 Desktop GUI or native Windows acceptance is claimed.
- Location and audit logging no longer depend on a lock file; POSIX deletion still requires the existing official flock inode. Windows never loads that addon.

## [0.1.0] - 2026-11-22

### Added

- Host-owned Trash markers, native archive integration, restore, reconciliation, and serialized operations (phase 1).
- Session context-menu and hover actions, generated Typert Remote integration, and English/Chinese UI (phase 2).
- A global sidebar/panel entry, current workspace labels, shared Client state, refresh, and inline deletion confirmation (phase 3).
- Permanent local JSONL session log deletion and Empty Trash with official flock, validated same-device rename staging, durable receipts, crash recovery, and retryable partial failures (phase 4).
- Best-effort persistent JSONL audit logs with operation stages and failure reasons.
- Isolated Host/Client, filesystem, recovery, audit-log, and installed-runtime discovery regressions.
- MIT license, bilingual installation and usage documentation, public repository metadata, and built `dist/` artifacts for git/directory distribution.

### Changed

- Replaced the local placeholder package identity with `d-trash`; Client registration and test fixtures derive the package identity from the manifest or generated contribution.
- Declared caret peer ranges while keeping development dependency versions pinned; DSH 0.2.2-rc.5 remains the verified boundary.

The 0.1.0 entry records delivered functionality and repository preparation. 0.2.0 is the first tagged public release; npm publication is a separate step.
