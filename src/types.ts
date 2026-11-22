/** Plugin-owned marker; session logs remain owned by DSH. */
export interface TrashRecord {
  /** Host retains a private purge receipt; show diagnosis and allow deletion retry. */
  purgePending?: boolean
  trashedAt: number
  workspaceId?: string
  titleSnapshot?: string
}
