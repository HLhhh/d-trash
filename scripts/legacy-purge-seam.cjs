// Earlier protocol/queue/UI regressions isolate filesystem I/O here. The Phase 4
// suite exercises the actual SessionPurger, native leases and injected system-trash moves instead.
module.exports = function legacyPurgeSeam(trash) {
  trash.purger = {
    async move(id, gate, save) {
      gate()
      await save({ source: 'protocol-fixture', dev: '0', ino: '0', moving: true })
      gate()
      return 'moved'
    },
    async deleteStaged() { return { status: 'deleted', home: 'protocol-fixture' } },
    async clearProjection() {},
  }
}
