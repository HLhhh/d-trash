# d-trash

[简体中文](./README_zh.md) · [Technical details](./docs/DETAIL.md) · [Changelog](./CHANGELOG.md) · [Releases](https://github.com/HLhhh/d-trash/releases)

GitHub primary repository · [Gitee mirror](https://gitee.com/huang-lin-java/d-trash)

A session recycle bin for DeepSeek Harness (DSH), with restore and moving local session logs to system trash.

## Why

Long session histories make the sidebar hard to navigate. Native archiving hides sessions but does not provide a separate recycle bin. `d-trash` adds a place to review those sessions, restore them, or move their local logs to system trash.

## Features

- **Move to Trash** from a session's context menu or hover action; keep its logs and workspace membership.
- **Restore** a session by unarchiving it and keeping its current workspace position.
- **Move to system trash** after confirmation; move the whole local session log directory to macOS Trash or Windows Recycle Bin, then clean necessary registry records. System-level recovery remains available.
- **Queue busy sessions** for automatic system-trash move retries after restarting DSH; Restore cancels the queue.
- **Empty Trash** across workspaces, with separate moved, queued, and failed counts.
- **Distill** a trashed conversation with a preset chosen for each run, saving a Markdown document without changing the source session.
- **Audit operations** in a local JSONL log, with stages and failure reasons.

The global panel lists sessions newest first, with titles, current workspaces, and English/Chinese UI text.

## Installation

Supports DSH **0.2.2-rc.2 and rc.5** and Node **`^22.19.0 || >=24.0.0`**. The repository includes built `dist/` files.

For a local checkout:

```sh
git clone https://github.com/HLhhh/d-trash.git
cd d-trash
npm install
```

Use the committed `dist/` directly. If you edit the source or need to regenerate it, run `npm install && npm run build` once before installation.

In DSH, open **Plugins → Add plugin** and enter the checkout's absolute directory path (run `pwd` in the checkout to obtain it). Once the GitHub repository is public, you can instead enter the git spec **`github:HLhhh/d-trash`**.

An agent can use **`plugin_manager` → `install_bundle`**, with `target` set to the same absolute directory or git spec. Select the intended profile and follow the manager's activation/restart result. Installation changes that profile for all its sessions.

These instructions do not assume an npm release; do not use a bare `d-trash` registry install until this project's npm ownership and publication are confirmed.

## Usage

| Entry | Action |
| --- | --- |
| Session context menu → Move to Trash | Archive the session and add a Trash marker |
| Session row → hover trash icon | Move the session to Trash |
| Left sidebar → Trash | Open the global recycle bin panel |
| Panel → Restore | Return a session to the normal session list |
| Panel → Move to system trash | Confirm moving that session's local logs to system trash |
| Panel → Empty Trash | Confirm moving all Trash sessions to system trash |
| Panel → Distill | Choose an agent preset, run a read-only task, then show the Markdown file path |
| Panel → Refresh | Reload the list and workspace projection |

Deletion requires inline confirmation; Cancel or Escape dismisses it. A queued session shows “Pending move to system trash (automatically retries after restarting DSH)”. Restore cancels its queue and keeps it archived in Trash with its logs and workspace membership; a later Restore uses the ordinary unarchive behavior. Once moving to system trash has started and a purge receipt exists, Restore is disabled: retry Move to system trash to finish cleanup.

## Distillation

Click **Distill** on a Trash row, choose a host agent preset, and start. DSH runs the selected preset with its **default model** in a separate task session; all tool execution is denied. The source is read through a read-only persistence handle, never resumed or write-locked by this operation, and keeps its marker, archive and workspace membership. The separate task has its own normal storage/lease and its logs are retained by DSH.

Results include the source ID/title/time, generation time, preset, type (experience, operations, skill draft or requirements) and structured Markdown. The default is **`<source session cwd>/d-trash-distill/<date>-<shortid>-distill.md`**; existing files are retained with a unique suffix for later runs. **Show file path** selects the full path to copy into your editor or file manager. Progress and staged failures appear inline; choose again to retry. Tasks time out after five minutes and are cancelled on Host unload.

| Host config | Default | Meaning |
| --- | --- | --- |
| `distillDir` | `""` | Empty uses the source session cwd plus `d-trash-distill`; otherwise an absolute directory. Required if the source has no cwd. Symlink/noncanonical paths and output under DSH’s persistence home are refused. |

If agent/preset/default-model services are unavailable, **Export a prompt (manual)** saves a clearly labelled prompt with the transcript for you to send yourself. No model is run in manual mode. Agent failures do not silently fall back. Pending cleanup rows cannot be distilled. Empty or very large transcripts are refused; provider context limits can be lower than the two-million-character input limit. Generated content needs review.

The integration was researched and probed against installed rc.5 with synthetic data and injected execution. No real model, real preset Loader run, Desktop GUI or Windows acceptance was performed; this does not extend the existing rc.2/rc.5 compatibility boundary. See [technical details and manual acceptance](./docs/DETAIL.md#p53-manual-acceptance).

## How it works

The Host service is the only writer of Trash state. Ordinary visible Trash is **`marker ∩ archived`**: native Archive never creates a Trash marker. Native unarchive removes a session from that intersection; the next Host list reconciles its stale marker. Native Archive and Pin behavior is preserved.

Moving to system trash requires a validated JSONL session path and matching filesystem identity. The Host acquires backend-compatible write exclusion: official `flock` on an existing `session.lock` on POSIX, or the backend-named kernel semaphore via Koffi on Windows. It persists a source-only move intent, rechecks identity and archive/marker gates, moves the whole directory to same-volume system trash, confirms the source is absent, and releases the lease. It then clears workspace membership, archive state and marker, and attempts projection-cache cleanup. macOS uses exclusive rename to `~/.Trash/d-trash-<uuid>` without Finder/osascript or permission-request APIs; Windows uses `SHFileOperationW` with `FOF_ALLOWUNDO` and suppressed UI. Unsupported platforms, cross-volume moves and unavailable native trash are rejected; there is no copy or physical-delete fallback.

Failed cleanup keeps durable receipts for retry. Recovery checks the source: if present with the same identity, cancel the unmoved intent and repeat all gates; if absent, continue record cleanup without guessing the system destination. Old staging receipts remain recoverable: validate them and move any remaining directory to system trash, never recursively delete it. Pending diagnostics stay visible independently of the ordinary Trash intersection.

If a stale Client list moves an already deleted session back to Trash, a first `stat` returning exactly `undefined` allows record cleanup while its marker exists and it remains archived. The Host skips log deletion, detaches current owning workspaces, unarchives, removes the marker, and attempts projection cleanup; delete returns `true`, and empty counts it as a success. Audit stage `logs-absent` explains this case. A thrown `stat` error (including I/O errors), a mismatched header id, a non-JSONL snapshot, or a relative/missing location still refuses cleanup. Existing purge receipts always follow receipt validation and recovery. Projection cleanup uses a previously validated stat/source home or another reliable session; without one it records a warning, and audit logging falls back to the Host logger.

After moving to system trash or ghost cleanup commits the marker removal, the Host best-effort emits the public `api-session/removed(sessionId)` event. The verified installed rc.5 Host transport forwards it to the real Client catalog, removing the stale row that would otherwise reappear under Ungrouped. Failed or queued deletion never sends it; notification errors only record `removed/warning` and preserve deletion success.

See [DETAIL.md](./docs/DETAIL.md) and [PLAN.md](./PLAN.md) for the full protocol and recovery boundaries.

## Compatibility

| Component | Requirement / verified boundary |
| --- | --- |
| DSH | Isolated API/build/test matrix: **0.2.2-rc.2 and rc.5**; DSH peers `^0.2.2-rc.2`; installed discovery on rc.5 |
| Cordis | Peer `^4.1.0` |
| Native filesystem support | POSIX: `@deepseek-ai/node-addon-system` peer `^0.1.2`; Windows: bundled dependency `koffi` 3.1.1 |
| Node.js | `^22.19.0 || >=24.0.0` |
| Host platform | 5.2: macOS isolation regressions and native rename into an injected temporary user home; real system Trash/Recycle Bin GUI acceptance is pending on both platforms. Earlier phase 4 Windows flow: maintainer-verified in the DSH desktop GUI on 2026-11-25 (install, sidebar entry, Move to Trash, Restore, Delete forever, Empty Trash). The Windows-only native regression cases are not run yet. |
| Session backend | JSONL only for moving to system trash; POSIX requires an existing lock file; Windows needs no lock file; unreliable paths/identity or unavailable native exclusion are rejected |

The earlier phase 4 Windows GUI delete flow was verified by the maintainer on 2026-11-25; this does not verify 5.2 system trash behavior; the Windows-only native regressions and the rc.2 Desktop GUI were not run. [Windows self-check commands](./docs/DETAIL.md#windows-self-check) and [5.2 manual acceptance steps](./docs/DETAIL.md#p52-manual-acceptance) use temporary synthetic homes only.

Peer ranges allow compatible updates; they do not mean later DSH versions have been tested. Recheck Client workspace projection and native locking after upgrading.

## Known limitations

- Client removal notifications are best effort and are not replayed after disconnection. `removed/ok` confirms local emission, not Client receipt; an earlier throwing Host listener can prevent forwarding. The official catalog re-reads on reconnect. Native later re-additions, retained subagent lineage, and search synchronization remain DSH-owned. The new transport/catalog probe uses installed rc.5 with synthetic data; the probe itself is not GUI or Windows acceptance.
- Loaded/entered sessions can remain locked by DSH. Delete/Empty queues lock-busy sessions without changing their logs, archive state, or workspace membership. Restart DSH to let the Host retry automatically; if a session is still busy it stays queued for the next restart, and Move to system trash can also retry manually. Startup maintenance runs in the background, retries unavailable services with backoff, and reports other errors by stage. There is no public unload/close API; the plugin never releases another owner’s handle, bypasses a lease, unlinks a live lock file, or steals a lock.
- Attachments, workspace files, Git worktrees, artifacts, server logs, backups, and other plugins' snapshots remain.
- Logs remain recoverable at the system level until the user or OS clears system trash. The plugin cannot detect that clearing and makes no irrecoverability guarantee. macOS Put Back metadata is not guaranteed; manual restoration to the original path may be needed. System restoration does not recreate cleared plugin/native registry records. Windows recovery follows system Recycle Bin policies; only fixed local volumes with an available same-volume bin are accepted. Search results still depend on DSH synchronization; cache cleanup failures are warnings.
- Trash sessions remain archived, so native views configured to show archived/all sessions can still display them.
- Operations are not a cross-service or cross-process transaction. Crash recovery uses durable receipts; power-loss-safe directory `fsync` is not guaranteed. Unknown staging directories without receipts are left alone.
- Audit logging is best effort: rotate before the next append after exceeding 4 MiB, keeping three archives (`trash.log.1`–`.3`). About 16 MiB of history is retained, with possible overshoot; missing records do not prove an operation did not happen.

## Audit log

The log is **`<home>/logs/trash.log`**, normally **`~/.dsh/logs/trash.log`**. The Host derives and validates `home` from the persistence stat/source path, not from the `DSH_HOME` environment variable. For a custom home, use that home in the commands below.

Each JSONL line contains **`ts`**, **`action`**, **`sessionId`**, **`stage`**, **`result`**, and **`reason`**. `ts` is ISO time; `reason` is `null` when there is no reason, and empty-trash summaries use `sessionId: null`. Actions include `trashSession`, `restoreSession`, `removeFromTrash`, `emptyTrash`, `recovery`, `startup`, and `log-rotate`. Queue acknowledgement records `deferred/ok`; Empty Trash summaries distinguish deleted, failed, and queued counts. The stable `[D_TRASH_DEFERRED] ` wire prefix is shown as a queued status instead of a deletion failure.

```sh
tail -F ~/.dsh/logs/trash.log
grep -h '"result":"failed"' ~/.dsh/logs/trash.log ~/.dsh/logs/trash.log.[123]
grep -h '"action":"recovery"' ~/.dsh/logs/trash.log ~/.dsh/logs/trash.log.[123]
```

The fixed constants are `MAX_BYTES = 4 * 1024 * 1024` and `KEEP = 3`; no environment configuration is needed. Rotation runs inside the process's shared per-path queue, removes `.3`, shifts archives in reverse order, and creates a 0600 active file (POSIX). A `log-rotate` record describes the file numbers and result. Only the oldest retained generation is intentionally discarded; retained lines are moved without truncation.

This is not cross-process strong consistency: another instance holding an old handle may continue writing complete lines into the rotated file, making `.1` larger. A short-lived `trash.log.rotate` directory coordinates cooperating rotators; a busy or crash-left guard causes bounded waiting and logger fallback, without automatic takeover. See [DETAIL.md](./docs/DETAIL.md) for recovery and concurrency boundaries. Archive globs may report missing files before the first rotations.

Log failures fall back to the Host logger and do not change the operation's result. This file is diagnostic evidence, not the deletion receipt store.

## License

[MIT](./LICENSE) · Copyright (c) 2026 HLhhh.
