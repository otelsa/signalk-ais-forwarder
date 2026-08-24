import { expect } from 'chai'
import { Stats } from '../src/stats'

const ENDPOINT_A = { ipaddress: '1.2.3.4', port: 14577 }
const ENDPOINT_B = { ipaddress: '5.6.7.8', port: 14578 }

describe('Stats', () => {
  it('syncEndpoints drops an endpoint removed from config out of the snapshot', () => {
    const stats = new Stats()
    stats.syncEndpoints([ENDPOINT_A, ENDPOINT_B])
    expect(stats.snapshot(true).endpoints).to.have.length(2)

    stats.syncEndpoints([ENDPOINT_A]) // B removed on reconfigure
    const endpoints = stats.snapshot(true).endpoints
    expect(endpoints).to.have.length(1)
    expect(endpoints[0]!.ipaddress).to.equal(ENDPOINT_A.ipaddress)
  })

  it('noteSendError records the error on both the endpoint and the overall snapshot', () => {
    const stats = new Stats()
    stats.syncEndpoints([ENDPOINT_A])
    stats.noteSendError(ENDPOINT_A, 'ENETUNREACH')

    const snapshot = stats.snapshot(true)
    expect(snapshot.lastError).to.equal('ENETUNREACH')
    expect(snapshot.lastErrorAt).to.be.a('number')
    expect(snapshot.endpoints[0]!.lastError).to.equal('ENETUNREACH')
    expect(snapshot.endpoints[0]!.lastErrorAt).to.be.a('number')
  })

  it('noteTargetSeen updates an already-tracked target in place rather than duplicating it', () => {
    const stats = new Stats()
    stats.noteTargetSeen('211111111', 'FIRST NAME', 'B')
    stats.noteTargetSeen('211111111', 'RENAMED', 'A')

    const snapshot = stats.snapshot(true)
    expect(snapshot.targetsTracked).to.equal(1)
    expect(snapshot.targets[0]!.name).to.equal('RENAMED')
    expect(snapshot.targets[0]!.aisClass).to.equal('A')
  })

  it('noteTargetSeen keeps the previous name when a later sighting has none', () => {
    const stats = new Stats()
    stats.noteTargetSeen('211111111', 'KEEP ME', 'B')
    stats.noteTargetSeen('211111111', undefined, 'B')

    expect(stats.snapshot(true).targets[0]!.name).to.equal('KEEP ME')
  })

  it('messagesSentLastMinute only counts sends within the trailing 60s window', () => {
    const stats = new Stats()
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now

      stats.noteMessageBroadcast('old message')
      now += 61_000 // outside the 60s window
      stats.noteMessageBroadcast('recent message')

      expect(stats.snapshot(true).messagesSentLastMinute).to.equal(1)
      expect(stats.snapshot(true).messagesSentTotal).to.equal(2)
    } finally {
      Date.now = realNow
    }
  })

  it('recentMessages keeps only the most recent RECENT_MESSAGES_LIMIT entries, newest first', () => {
    const stats = new Stats()
    for (let i = 0; i < 30; i++) {
      stats.noteMessageBroadcast(`message ${i}`)
    }

    const recent = stats.snapshot(true).recentMessages
    expect(recent).to.have.length(25)
    expect(recent[0]!.nmea).to.equal('message 29')
    expect(recent[24]!.nmea).to.equal('message 5')
  })

  it('pruneTargets removes targets that fell out of the active set', () => {
    const stats = new Stats()
    stats.noteTargetSeen('211111111', 'A', 'B')
    stats.noteTargetSeen('222222222', 'B', 'B')

    stats.pruneTargets(new Set(['211111111']))

    const targets = stats.snapshot(true).targets
    expect(targets).to.have.length(1)
    expect(targets[0]!.mmsi).to.equal('211111111')
  })

  it('caps the lifetime-seen count so an unattended multi-year run stays bounded, as a pure safety backstop', () => {
    const stats = new Stats()
    for (let i = 0; i < 100_001; i++) {
      stats.noteTargetSeen(`mmsi-${i}`, undefined, 'B')
    }
    expect(stats.snapshot(true).targetsSeenTotal).to.equal(100_000)
  })

  it('noteSocketError sets the overall lastError without touching any per-endpoint stats', () => {
    const stats = new Stats()
    stats.syncEndpoints([ENDPOINT_A])
    stats.noteSocketError('EMFILE')

    const snapshot = stats.snapshot(true)
    expect(snapshot.lastError).to.equal('EMFILE')
    expect(snapshot.lastErrorAt).to.be.a('number')
    expect(snapshot.endpoints[0]!.lastError).to.be.undefined
  })

  it('targetsSeenTotal keeps counting distinct vessels even after they are pruned from the active set', () => {
    const stats = new Stats()
    stats.noteTargetSeen('211111111', 'A', 'B')
    stats.pruneTargets(new Set())

    expect(stats.snapshot(true).targetsTracked).to.equal(0)
    expect(stats.snapshot(true).targetsSeenTotal).to.equal(1)
  })
})
