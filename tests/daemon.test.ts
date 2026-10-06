import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { runDaemonDoctor } from '../scripts/daemon-doctor.js'

const binary = process.env.CODEX_BIN || 'codex'
const available = spawnSync(binary, ['app-server', 'daemon', '--help'], { stdio: 'ignore' }).status === 0

test('isolated daemon shares a loaded thread and two-way events between real proxy clients', { skip: !available, timeout: 55_000 }, async () => {
  const report = await runDaemonDoctor(binary)
  assert.equal(report.sharedThread, true)
  assert.equal(report.twoWayRenameEvents, true)
  assert.equal(report.reconnectPreservesThread, true)
  assert.equal(report.bridgeProxyVerified, true)
  assert.equal(report.activeShellTurnJoined, true)
  assert.equal(report.optimisticConfigWrites, true)
  assert.equal(report.oversizedFrameKeepsConnection, true)
  assert.equal(report.inferencePerformed, false)
  assert.equal(report.desktopDaemonTouched, false)
})
