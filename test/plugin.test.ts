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
import { AisDecode } from 'ggencoder'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createPlugin = require('../src/index')

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

describe('signalk-ais-forwarder-noomi', () => {
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

    let snapshot: any
    const fakeRouter: any = {
      access: () => ({
        get: (
          _path: string,
          handler: (req: unknown, res: { json: (b: unknown) => void }) => void
        ) => {
          handler({}, { json: (body: unknown) => (snapshot = body) })
        }
      })
    }
    plugin.registerWithRouter(fakeRouter)

    await new Promise((r) => setTimeout(r, 50))
    plugin.stop()
    await h.close()

    expect(snapshot.targetsTracked).to.equal(1)
    expect(snapshot.targets[0].mmsi).to.equal('261666666')
    expect(snapshot.endpoints[0].ipaddress).to.equal('127.0.0.1')
    expect(snapshot.messagesSentTotal).to.be.greaterThan(0)
  })
})
