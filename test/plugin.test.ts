/*
 * End-to-end tests for the plugin.
 *
 * A stub Signal K app exposes only what the plugin actually uses
 * (signalk.retrieve, selfId, handleMessage, setPluginStatus, error/debug)
 * plus a real UDP socket bound to 127.0.0.1 that captures whatever the
 * plugin sends, so each test exercises the full path: poll tick -> read
 * the data model -> encode -> UDP send -> decode.
 */

import { expect } from 'chai'
import * as dgram from 'dgram'
import { EventEmitter } from 'events'
import { AisDecode } from 'ggencoder'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createPlugin = require('../src/index')
// TypeScript's esModuleInterop namespace import (`import * as dgram`) wraps
// the real module in a fresh object with getter-only accessors, so it can't
// be monkey-patched directly -- go through require() for the actual mutable
// module object. src/index.ts's own namespace import reads through this
// same live getter, so mutating this object here really does swap out what
// the plugin's dgram.createSocket call resolves to.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dgramModule: typeof dgram = require('dgram')

interface Harness {
  app: any
  vessels: Record<string, any>
  handled: Array<Record<string, unknown>>
  received: Buffer[]
  port: number
  close: () => Promise<void>
}

async function createHarness(): Promise<Harness> {
  const received: Buffer[] = []
  const server = dgram.createSocket('udp4')
  server.on('message', (msg) => received.push(msg))
  const port: number = await new Promise((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address()
      if (typeof addr === 'string' || !addr) {
        reject(new Error('no udp address'))
        return
      }
      resolve(addr.port)
    })
    server.bind(0, '127.0.0.1')
  })

  const vessels: Record<string, any> = {}
  const handled: Array<Record<string, unknown>> = []

  const app: any = {
    selfId: 'urn:mrn:imo:mmsi:211653340',
    signalk: { retrieve: () => ({ vessels }) },
    handleMessage: (_id: string, msg: Record<string, unknown>) =>
      handled.push(msg),
    setPluginStatus: () => undefined,
    error: () => undefined,
    debug: () => undefined
  }

  return {
    app,
    vessels,
    handled,
    received,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

// Builds a fake PluginRouter that captures whatever gets res.json()'d to
// '/status', in whichever of the three real-world shapes registerWithRouter
// might see: a working router.access() ('ok'), one that exists but throws
// ('throws'), or one missing entirely ('missing', the default).
function fakeStatusRouter(
  opts: { access?: 'ok' | 'throws' | 'missing' } = {}
): { router: any; getSnapshot: () => any } {
  let snapshot: any
  const get = (
    _path: string,
    handler: (req: unknown, res: { json: (b: unknown) => void }) => void
  ) => handler({}, { json: (body: unknown) => (snapshot = body) })

  const router: any = { get }
  if (opts.access === 'ok') {
    router.access = () => ({ get })
  } else if (opts.access === 'throws') {
    router.access = () => {
      throw new Error('router.access is not a function')
    }
  }

  return { router, getSnapshot: () => snapshot }
}

// Swaps in a fake dgram socket for the duration of `run`, guaranteeing the
// real dgram.createSocket is restored even if plugin creation/start itself
// throws -- the patch and its try/finally are scoped together here so a
// caller can't accidentally split them and leave dgram.createSocket
// monkey-patched for every later test in the process.
async function withFakeSocket(
  sendImpl: (
    msg: unknown,
    offset: number,
    length: number,
    port: number,
    address: string,
    cb: (err: Error | null) => void
  ) => void,
  run: (fakeSocket: EventEmitter) => Promise<void>
): Promise<void> {
  const realCreateSocket = dgramModule.createSocket
  const fakeSocket: any = new EventEmitter()
  fakeSocket.send = sendImpl
  fakeSocket.close = () => undefined
  dgramModule.createSocket = (() => fakeSocket) as typeof dgram.createSocket
  try {
    await run(fakeSocket)
  } finally {
    dgramModule.createSocket = realCreateSocket
  }
}

function foreignVessel(opts: {
  mmsi: string
  lat: number
  lon: number
  pgn?: number
  name?: string
  navState?: string
  ageMs?: number
}): any {
  const timestamp = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString()
  return {
    mmsi: opts.mmsi,
    name: opts.name,
    navigation: {
      position: {
        value: { latitude: opts.lat, longitude: opts.lon },
        timestamp,
        pgn: opts.pgn
      },
      ...(opts.navState ? { state: { value: opts.navState } } : {})
    }
  }
}

describe('signalk-ais-forwarder', () => {
  it('forwards a Class B target as a decodable type 18 sentence', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261999999'] = foreignVessel({
      mmsi: '261999999',
      lat: 54.35,
      lon: 18.65,
      pgn: 129039,
      name: 'FOREIGN B'
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    expect(h.received.length).to.be.greaterThan(0)
    const decoded = h.received.map((b) => new AisDecode(b.toString().trim()))
    const position = decoded.find((d) => d.aistype === 18)
    expect(position).to.not.be.undefined
    expect(position!.mmsi).to.equal('261999999')
    expect(position!.lat).to.be.closeTo(54.35, 0.01)
  })

  it('forwards a Class A target (pgn 129038) as type 1 with nav status', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261888888'] = foreignVessel({
      mmsi: '261888888',
      lat: 54.4,
      lon: 18.7,
      pgn: 129038,
      name: 'FOREIGN A',
      navState: 'anchored'
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    const decoded = h.received.map((b) => new AisDecode(b.toString().trim()))
    const position = decoded.find((d) => d.aistype === 1)
    expect(position).to.not.be.undefined
    expect(position!.navstatus).to.equal(1) // anchored
  })

  it('sends both parts of a Class B static message when both encode successfully, not just the first', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261777776'] = {
      mmsi: '261777776',
      name: 'BOTH PARTS',
      navigation: {
        position: {
          value: { latitude: 54.35, longitude: 18.65 },
          timestamp: new Date().toISOString(),
          pgn: 129039
        }
      },
      communication: { callsignVhf: { value: 'DA1234' } },
      design: {
        length: { value: { overall: 12 } },
        beam: { value: 4 }
      },
      sensors: {
        gps: { fromBow: { value: 6 }, fromCenter: { value: 0 } }
      }
    }

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 100,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    // Both type 24 parts must go out -- a naive Array.some() over
    // [partZero, partOne] stops at the first truthy result, so Part 0
    // (the name) encoding successfully would silently swallow Part 1
    // (callsign/dimensions) forever.
    const decoded = h.received.map((b) => new AisDecode(b.toString().trim()))
    const partZero = decoded.find((d) => d.aistype === 24 && d.part === 0)
    const partOne = decoded.find((d) => d.aistype === 24 && d.part === 1)
    expect(partZero, 'part 0 (name)').to.not.be.undefined
    expect(partOne, 'part 1 (callsign/dimensions)').to.not.be.undefined
    expect(partOne!.callsign).to.equal('DA1234')
  })

  it('never forwards the self vessel', async () => {
    const h = await createHarness()
    h.vessels[h.app.selfId] = foreignVessel({
      mmsi: '211653340',
      lat: 1,
      lon: 1,
      pgn: 129038
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    expect(h.received.length).to.equal(0)
  })

  it('does not forward a target whose position is older than targetStalenessMinutes', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261777777'] = foreignVessel({
      mmsi: '261777777',
      lat: 54.35,
      lon: 18.65,
      pgn: 129039,
      ageMs: 20 * 60 * 1000 // 20 minutes old
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    expect(h.received.length).to.equal(0)
  })

  it('exposes a status snapshot reflecting configured endpoints and tracked targets', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261666666'] = foreignVessel({
      mmsi: '261666666',
      lat: 54.35,
      lon: 18.65,
      pgn: 129039,
      name: 'TRACKED'
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    const { router, getSnapshot } = fakeStatusRouter({ access: 'ok' })
    plugin.registerWithRouter(router)

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    const snapshot = getSnapshot()
    expect(snapshot.targetsTracked).to.equal(1)
    expect(snapshot.targets[0].mmsi).to.equal('261666666')
    expect(snapshot.endpoints[0].ipaddress).to.equal('127.0.0.1')
    expect(snapshot.messagesSentTotal).to.be.greaterThan(0)
  })

  it('registerWithRouter does not throw against a router without .access() (observed on noomi: server-api declares it, some core builds do not implement it)', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 100,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    const { router, getSnapshot } = fakeStatusRouter({ access: 'missing' })

    expect(() => plugin.registerWithRouter(router)).to.not.throw()
    expect(getSnapshot().targetsTracked).to.equal(0)

    plugin.stop()
    await h.close()
  })

  it('registerWithRouter falls back to router.get when router.access exists but itself throws', async () => {
    const h = await createHarness()
    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 100,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    const { router, getSnapshot } = fakeStatusRouter({ access: 'throws' })

    expect(() => plugin.registerWithRouter(router)).to.not.throw()
    expect(getSnapshot().targetsTracked).to.equal(0)

    plugin.stop()
    await h.close()
  })

  it('does not forward a target whose position is NaN (a decode glitch), rather than treating it as a real fix', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261222222'] = foreignVessel({
      mmsi: '261222222',
      lat: NaN,
      lon: 18.65,
      pgn: 129039
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    expect(h.received.length).to.equal(0)
  })

  it('derives heading from magnetic heading + variation when true heading is unavailable (an HDG-only compass)', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261999998'] = {
      mmsi: '261999998',
      navigation: {
        position: {
          value: { latitude: 54.35, longitude: 18.65 },
          timestamp: new Date().toISOString(),
          pgn: 129039
        },
        headingMagnetic: { value: 1.0 }, // ~57.3deg
        magneticVariation: { value: 0.1 } // ~5.7deg east
      }
    }

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    const decoded = h.received.map((b) => new AisDecode(b.toString().trim()))
    const position = decoded.find((d) => d.aistype === 18)
    expect(position).to.not.be.undefined
    // (1.0 + 0.1) rad -> degrees, normalized into [0, 360)
    const expectedDeg = (((1.1 * 180) / Math.PI) % 360) + 360
    expect(position!.hdg).to.be.closeTo(expectedDeg % 360, 1)
  })

  it('does not forward a target whose position has no timestamp at all', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261111111'] = {
      mmsi: '261111111',
      navigation: {
        position: {
          value: { latitude: 54.35, longitude: 18.65 },
          pgn: 129039
          // no timestamp field -- age can't be computed, so it can't be
          // proven fresh either
        }
      }
    }

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    expect(h.received.length).to.equal(0)
  })

  it('does not count a broadcast as sent when no endpoints are configured', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261000000'] = foreignVessel({
      mmsi: '261000000',
      lat: 54.35,
      lon: 18.65,
      pgn: 129039
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [], // dropped by sanitizeEndpoints or simply never configured
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 30))

    const { router, getSnapshot } = fakeStatusRouter()
    plugin.registerWithRouter(router)
    plugin.stop()
    await h.close()

    // Without this fix, messagesSentTotal would keep climbing even though
    // nothing ever reached a socket -- the primary "is it working" signal
    // actively lying about a dropped/misconfigured endpoint.
    expect(getSnapshot().messagesSentTotal).to.equal(0)
  })

  it('stops tracking a target once it disappears entirely, without leaking its per-target throttle state', async function () {
    this.timeout(5000) // needs a real ~1s poll tick past the floored pollIntervalSeconds
    const h = await createHarness()
    const vesselKey = 'urn:mrn:imo:mmsi:261444444'
    h.vessels[vesselKey] = foreignVessel({
      mmsi: '261444444',
      lat: 54.35,
      lon: 18.65,
      pgn: 129039,
      name: 'FLAPPY'
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      // pollIntervalSeconds is floored to 1s (see sanitizeRateSeconds'
      // minSeconds guard) regardless of what's asked for here, so the
      // second poll tick this test needs is at least 1s away.
      pollIntervalSeconds: 1,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 30)) // first poll (from start()) forwards it
    delete h.vessels[vesselKey] // vessel disappears from the data model entirely
    await new Promise((r) => setTimeout(r, 1100)) // a later poll tick sees it gone and prunes it

    const { router, getSnapshot } = fakeStatusRouter()
    plugin.registerWithRouter(router)
    plugin.stop()
    await h.close()

    expect(getSnapshot().targetsTracked).to.equal(0)
  })

  it('statusMessage() reports the current snapshot summary once running', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261333333'] = foreignVessel({
      mmsi: '261333333',
      lat: 54.35,
      lon: 18.65,
      pgn: 129039
    })

    const plugin = createPlugin(h.app)
    plugin.start({
      endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
      pollIntervalSeconds: 100,
      minForwardIntervalSeconds: 0.01,
      staticUpdateIntervalSeconds: 100,
      targetStalenessMinutes: 15
    })

    await new Promise((r) => setTimeout(r, 30))
    const message = plugin.statusMessage()
    plugin.stop()
    await h.close()

    expect(message).to.match(/1 targets/)
  })

  it('statusMessage() reports the start error when the server is missing required capabilities', () => {
    const app: any = {
      // deliberately no signalk.retrieve, no selfId
      setPluginStatus: () => undefined,
      error: () => undefined,
      debug: () => undefined
    }
    const plugin = createPlugin(app)
    plugin.start({})

    expect(plugin.statusMessage()).to.match(/not started/)
    expect(plugin.started).to.equal(false)
  })

  it('records a UDP send error via stats and the error() log, without throwing', async () => {
    const h = await createHarness()
    h.vessels['urn:mrn:imo:mmsi:261555555'] = foreignVessel({
      mmsi: '261555555',
      lat: 54.35,
      lon: 18.65,
      pgn: 129039,
      name: 'ERR TARGET'
    })

    const errors: string[] = []
    h.app.error = (msg: string) => errors.push(msg)
    const sendError = new Error('simulated send failure')

    await withFakeSocket(
      (_msg, _offset, _length, _port, _address, cb) => cb(sendError),
      async () => {
        const plugin = createPlugin(h.app)
        try {
          plugin.start({
            endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
            pollIntervalSeconds: 100,
            minForwardIntervalSeconds: 0.01,
            staticUpdateIntervalSeconds: 100,
            targetStalenessMinutes: 15
          })

          await new Promise((r) => setTimeout(r, 30))

          const { router, getSnapshot } = fakeStatusRouter()
          plugin.registerWithRouter(router)
          const snapshot = getSnapshot()

          expect(snapshot.lastError).to.equal('simulated send failure')
          expect(snapshot.endpoints[0].lastError).to.equal(
            'simulated send failure'
          )
          expect(
            errors.some((m) => m.includes('simulated send failure'))
          ).to.equal(true)
        } finally {
          plugin.stop()
        }
      }
    )
    await h.close()
  })

  it('does not crash when the UDP socket itself emits an error event, and reflects the fault in status rather than looking healthy', async () => {
    const h = await createHarness()
    const errors: string[] = []
    h.app.error = (msg: string) => errors.push(msg)

    await withFakeSocket(
      () => undefined,
      async (fakeSocket) => {
        const plugin = createPlugin(h.app)
        try {
          expect(() =>
            plugin.start({
              endpoints: [],
              pollIntervalSeconds: 100,
              minForwardIntervalSeconds: 100,
              staticUpdateIntervalSeconds: 100,
              targetStalenessMinutes: 15
            })
          ).to.not.throw()

          // An EventEmitter with no 'error' listener throws on this event --
          // if the plugin's own handler weren't registered, this line
          // itself would throw and fail the test.
          expect(() =>
            fakeSocket.emit('error', new Error('EMFILE'))
          ).to.not.throw()
          expect(errors.some((m) => m.includes('EMFILE'))).to.equal(true)

          const { router, getSnapshot } = fakeStatusRouter()
          plugin.registerWithRouter(router)
          // plugin.started stays true (the fault doesn't crash the poll
          // loop), but lastError must reflect the fault -- otherwise an
          // operator watching /status has no way to learn the socket died.
          expect(getSnapshot().lastError).to.equal('EMFILE')
        } finally {
          plugin.stop()
        }
      }
    )
    await h.close()
  })

  describe('ownVessel reporting', () => {
    function selfVessel(opts: { mmsi: string; lat: number; lon: number }): any {
      return {
        mmsi: opts.mmsi,
        name: 'NOOMI',
        navigation: {
          position: {
            value: { latitude: opts.lat, longitude: opts.lon },
            timestamp: new Date().toISOString()
          }
        }
      }
    }

    it('does not report the own vessel when ownVessel.enabled is unset (default off)', async () => {
      const h = await createHarness()
      h.vessels[h.app.selfId] = selfVessel({
        mmsi: '211653340',
        lat: 54.35,
        lon: 18.65
      })

      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        pollIntervalSeconds: 100,
        minForwardIntervalSeconds: 0.01,
        staticUpdateIntervalSeconds: 100,
        targetStalenessMinutes: 15
      })

      await new Promise((r) => setTimeout(r, 50))
      plugin.stop()
      await h.close()

      expect(h.received.length).to.equal(0)
    })

    it('reports the own vessel as a decodable Class B type 18 sentence when ownVessel.enabled is on', async () => {
      const h = await createHarness()
      h.vessels[h.app.selfId] = selfVessel({
        mmsi: '211653340',
        lat: 54.35,
        lon: 18.65
      })

      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        pollIntervalSeconds: 100,
        minForwardIntervalSeconds: 100,
        staticUpdateIntervalSeconds: 100,
        targetStalenessMinutes: 15,
        ownVessel: { enabled: true, positionRateSeconds: 0.01 }
      })

      await new Promise((r) => setTimeout(r, 50))
      plugin.stop()
      await h.close()

      const decoded = h.received.map((b) => new AisDecode(b.toString().trim()))
      const position = decoded.find((d) => d.aistype === 18)
      expect(position).to.not.be.undefined
      expect(position!.mmsi).to.equal('211653340')
      expect(position!.lat).to.be.closeTo(54.35, 0.01)
    })

    it('sends own-vessel Class B static parts once a first position has been reported', async () => {
      const h = await createHarness()
      h.vessels[h.app.selfId] = {
        ...selfVessel({ mmsi: '211653340', lat: 54.35, lon: 18.65 }),
        communication: { callsignVhf: { value: 'DA9999' } }
      }

      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        pollIntervalSeconds: 100,
        minForwardIntervalSeconds: 100,
        staticUpdateIntervalSeconds: 100,
        targetStalenessMinutes: 15,
        ownVessel: {
          enabled: true,
          positionRateSeconds: 0.01,
          staticRateSeconds: 100
        }
      })

      await new Promise((r) => setTimeout(r, 50))
      plugin.stop()
      await h.close()

      const decoded = h.received.map((b) => new AisDecode(b.toString().trim()))
      const partZero = decoded.find((d) => d.aistype === 24 && d.part === 0)
      const partOne = decoded.find((d) => d.aistype === 24 && d.part === 1)
      expect(partZero, 'part 0 (name)').to.not.be.undefined
      expect(partOne, 'part 1 (callsign)').to.not.be.undefined
      expect(partOne!.callsign).to.equal('DA9999')
    })

    it('warns (without throwing) and sends nothing when ownVessel.enabled is on but this vessel has no mmsi', async () => {
      const h = await createHarness()
      h.vessels[h.app.selfId] = {
        navigation: {
          position: {
            value: { latitude: 54.35, longitude: 18.65 },
            timestamp: new Date().toISOString()
          }
        }
      }
      const errors: string[] = []
      h.app.error = (msg: string) => errors.push(msg)

      const plugin = createPlugin(h.app)
      expect(() =>
        plugin.start({
          endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
          pollIntervalSeconds: 100,
          minForwardIntervalSeconds: 100,
          staticUpdateIntervalSeconds: 100,
          targetStalenessMinutes: 15,
          ownVessel: { enabled: true, positionRateSeconds: 0.01 }
        })
      ).to.not.throw()

      await new Promise((r) => setTimeout(r, 50))
      plugin.stop()
      await h.close()

      expect(h.received.length).to.equal(0)
      expect(errors.some((m) => m.includes('no mmsi'))).to.equal(true)
    })

    it('keeps resending the last known own-vessel position when sendLastKnownPosition is on and no fresh fix arrives', async function () {
      this.timeout(5000)
      const h = await createHarness()
      h.vessels[h.app.selfId] = selfVessel({
        mmsi: '211653340',
        lat: 54.35,
        lon: 18.65
      })

      const plugin = createPlugin(h.app)
      plugin.start({
        endpoints: [{ ipaddress: '127.0.0.1', port: h.port }],
        pollIntervalSeconds: 1,
        minForwardIntervalSeconds: 100,
        staticUpdateIntervalSeconds: 100,
        targetStalenessMinutes: 15,
        ownVessel: {
          enabled: true,
          // A long position rate means the one fresh send happens on the
          // very first tick (0 elapsed since ownVesselLastForwardAt=0
          // trivially clears any rate), then never again during this
          // test -- everything after that first send must come from the
          // last-known-position path, not a second fresh read.
          positionRateSeconds: 1000,
          sendLastKnownPosition: true,
          lastKnownPositionRateSeconds: 1
        }
      })

      await new Promise((r) => setTimeout(r, 30)) // the first, fresh send
      const afterFirst = h.received.length
      expect(afterFirst).to.be.greaterThan(0)

      await new Promise((r) => setTimeout(r, 2200)) // a couple of 1s poll ticks
      plugin.stop()
      await h.close()

      // Same position, sent again without a new fix arriving -- proves the
      // resend came from the stored last-known NMEA, not a fresh dynamic
      // read (positionRateSeconds is far too long for that).
      expect(h.received.length).to.be.greaterThan(afterFirst)
    })
  })
})
