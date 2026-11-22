# d-trash

[简体中文](./README_zh.md) · [Technical details](./docs/DETAIL.md) · [Changelog](./CHANGELOG.md)

A session recycle bin for DeepSeek Harness (DSH), with restore and permanent local session log deletion.

## Why

Long session histories make the sidebar hard to navigate. Native archiving hides sessions but does not provide a separate recycle bin. `d-trash` adds a place to review those sessions, restore them, or delete their local logs.

## Features

- **Move to Trash** from a session's context menu or hover action; keep its logs and workspace membership.
- **Restore** a session by unarchiving it and keeping its current workspace position.
- **Delete forever** after confirmation; remove local session logs and necessary registry records. This cannot be undone.
- **Empty Trash** across workspaces, with per-session failures retained for retry.
- **Audit operations** in a local JSONL log, with stages and failure reasons.

The global panel lists sessions newest first, with titles, current workspaces, and English/Chinese UI text.

## Installation

Requires DSH **0.2.2-rc.5** and Node **`^22.19.0 || >=24.0.0`**. The repository includes built `dist/` files.

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
| Panel → Delete forever | Confirm permanent deletion of that session's local logs |
| Panel → Empty Trash | Confirm permanent deletion of all Trash sessions |
| Panel → Refresh | Reload the list and workspace projection |

Deletion requires inline confirmation; Cancel or Escape dismisses it. A pending deletion cannot be restored or moved to Trash again: retry deletion to finish its recorded cleanup.

## How it works

The Host service is the only writer of Trash state. Ordinary visible Trash is **`marker ∩ archived`**: native Archive never creates a Trash marker. Native unarchive removes a session from that intersection; the next Host list reconciles its stale marker. Native Archive and Pin behavior is preserved.

Permanent deletion requires a validated JSONL session path and matching filesystem identity. The Host acquires the official exclusive `flock` on the existing `session.lock`, persists deletion intent, rechecks identity, renames the whole session directory into a same-device staging directory beside `sessions`, closes the lock, then removes the staged directory. It then clears workspace membership, archive state, and the marker, and attempts projection-cache cleanup. Failed cleanup keeps durable receipts for a later delete/empty retry; pending diagnostics stay visible independently of the ordinary Trash intersection.

See [DETAIL.md](./docs/DETAIL.md) and [PLAN.md](./PLAN.md) for the full protocol and recovery boundaries.

## Compatibility

| Component | Requirement / verified boundary |
| --- | --- |
| DSH | Verified against **0.2.2-rc.5**; DSH peers declare `^0.2.2-rc.5` |
| Cordis | Peer `^4.1.0` |
| Native filesystem support | `@deepseek-ai/node-addon-system` peer `^0.1.2` |
| Node.js | `^22.19.0 || >=24.0.0` |
| Host platform | Verified on macOS; deletion requires POSIX and official native flock support; Windows is unsupported |
| Session backend | JSONL only for permanent deletion; missing locks or unreliable paths/identity are rejected |

Peer ranges allow compatible updates; they do not mean later DSH versions have been tested. Recheck Client workspace projection and native locking after upgrading.

## Known limitations

- Attachments, workspace files, Git worktrees, artifacts, server logs, backups, and other plugins' snapshots remain.
- Deletion is not secure erasure. Search results may take time to converge through DSH's existing synchronization; cache cleanup failures are warnings.
- Trash sessions remain archived, so native views configured to show archived/all sessions can still display them.
- Operations are not a cross-service or cross-process transaction. Crash recovery uses durable receipts; power-loss-safe directory `fsync` is not guaranteed. Unknown staging directories without receipts are left alone.
- Audit logging is best effort, with no rotation, size limit, or retention policy. Missing records do not prove an operation did not happen.

## Audit log

The log is **`<home>/logs/trash.log`**, normally **`~/.dsh/logs/trash.log`**. The Host derives and validates `home` from the persistence stat/source path, not from the `DSH_HOME` environment variable. For a custom home, use that home in the commands below.

Each JSONL line contains **`ts`**, **`action`**, **`sessionId`**, **`stage`**, **`result`**, and **`reason`**. `ts` is ISO time; `reason` is `null` when there is no reason, and empty-trash summaries use `sessionId: null`. Actions include `trashSession`, `restoreSession`, `removeFromTrash`, `emptyTrash`, and `recovery`.

```sh
tail -f ~/.dsh/logs/trash.log
grep '"result":"failed"' ~/.dsh/logs/trash.log
grep '"action":"recovery"' ~/.dsh/logs/trash.log
```

Log failures fall back to the Host logger and do not change the operation's result. This file is diagnostic evidence, not the deletion receipt store.

## License

[MIT](./LICENSE) · Copyright (c) 2026 HLhhh.
