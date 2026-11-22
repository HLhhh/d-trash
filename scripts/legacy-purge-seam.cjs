// Earlier protocol/queue/UI regressions isolate filesystem I/O here. The Phase 4
// suite exercises the actual SessionPurger, native flock, rename and rm instead.
module.exports = function legacyPurgeSeam(trash) {
  trash.purger = {
    async move(id, gate, save) {
      gate()
      await save({ source: 'protocol-fixture', target: id, dev: '0', ino: '0', logsDeleted: false, deleting: false })
      gate()
    },
    async deleteStaged() { return { status: 'deleted', home: 'protocol-fixture' } },
    async clearProjection() {},
  }
}
