# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Delete/empty now cleans ghost records re-created from stale Client lists when the first persistence `stat` explicitly returns `undefined` and marker/archive gates pass. Cleanup skips log deletion, records `logs-absent`, detaches current owners, unarchives, removes the marker, and attempts projection cleanup using a validated home. Thrown stat errors (including I/O failures), unreliable snapshots, and missing locations during later locked rechecks still refuse cleanup. Existing purge receipt validation/recovery is preserved. Added isolated ghost, refusal, interleaving, and recovery regressions for Node and installed Electron discovery.

### Added

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

The 0.1.0 entry records delivered functionality and repository preparation; npm publication and a public release are separate steps.
