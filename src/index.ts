/*
 * signalk-ais-forwarder
 *
 * Forwards AIS targets received by this Signal K server (from an N2K bus,
 * a serial AIS receiver, or any other source that ends up in the Signal K
 * data model) to UDP endpoints such as MarineTraffic or AISHub, so this
 * vessel can act as a roaming/relay AIS station.
 *
 * This plugin is a fork combining two upstream projects:
 *  - hkapanen/ais-forwarder (Apache-2.0) for the UDP-forwarder concept and
 *    endpoint configuration shape.
 *  - SignalK/aisreporter (Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>,
 *    Apache-2.0) for the Signal-K-data-model-to-AIS-sentence encoding
 *    approach and several helper functions (see src/encode.ts).
 *
 * Unlike ais-forwarder, this plugin does not listen for raw NMEA0183
 * AIVDM/AIVDO sentences on the server's event bus -- on this installation
 * (and many others using an N2K AIS receiver) those are never emitted
 * unless a separate NMEA2000-to-0183 conversion plugin is running.
 * Instead, like aisreporter, it reads the Signal K full data model
 * directly and re-encodes each received vessel's position into an AIS
 * sentence. This works regardless of whether the original AIS traffic
 * arrived via N2K, serial NMEA0183, or another plugin.
 *
 * Own-vessel position reporting is intentionally NOT handled here --
 * that is already covered by the separate aisreporter plugin.
 */

import * as dgram from 'dgram'
import type {
  Plugin,
  PluginRouter,
  Position,
  ServerAPI
} from '@signalk/server-api'
import {
  encodePositionReport,
  encodeStaticClassA,
  encodeStaticClassBPartOne,
  encodeStaticClassBPartZero,
  isNullIsland,
  sanitizeEndpoints,
  sanitizeRateSeconds,
  type Endpoint,
  type TargetDynamic,
  type TargetStatic
} from './encode'
import { Stats } from './stats'

// app.signalk.retrieve() is a real, widely-used server capability but is
// not yet part of the published ServerAPI types (see the "typing is
// incomplete" note in @signalk/server-api). Declared locally rather than
// patched into node_modules.
interface FullDataModelApp extends ServerAPI {
  signalk: { retrieve(): { vessels?: Record<string, VesselNode> } }
  selfId: string
}

type VesselNode = Record<string, unknown>

interface ValueNode<T> {
  value?: T
  timestamp?: string
  pgn?: number
}

function getNode(
  vessel: VesselNode,
  path: string
): ValueNode<unknown> | undefined {
  let cursor: unknown = vessel
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor as ValueNode<unknown> | undefined
}

function getValue<T>(vessel: VesselNode, path: string): T | undefined {
  return getNode(vessel, path)?.value as T | undefined
}

// Mirrors aisreporter's own-vessel heading fallback: prefer true heading,
// else derive it from magnetic heading + variation (a compass emitting
// NMEA HDG rather than HDT leaves only a magnetic heading in the model).
function resolveTrueHeadingRad(vessel: VesselNode): number | undefined {
  const trueHeading = getValue<number>(vessel, 'navigation.headingTrue')
  if (typeof trueHeading === 'number' && Number.isFinite(trueHeading)) {
    return trueHeading
  }
  const magneticHeading = getValue<number>(vessel, 'navigation.headingMagnetic')
  const variation = getValue<number>(vessel, 'navigation.magneticVariation')
  if (
    typeof magneticHeading === 'number' &&
    Number.isFinite(magneticHeading) &&
    typeof variation === 'number' &&
    Number.isFinite(variation)
  ) {
    return magneticHeading + variation
  }
  return undefined
}

// PGN 129038 = AIS Class A Position Report, 129039 = AIS Class B. Targets
// arriving from a non-N2K source (no pgn tag) default to Class B, which
// keeps the encoded sentence valid without guessing a nav status.
function classifyAis(positionPgn: number | undefined): 'A' | 'B' {
  return positionPgn === 129038 ? 'A' : 'B'
}

interface PluginConfig {
  endpoints: Endpoint[]
  pollIntervalSeconds: number
  minForwardIntervalSeconds: number
  staticUpdateIntervalSeconds: number
  targetStalenessMinutes: number
}

function readConfig(
  props: Record<string, unknown>,
  warn: (msg: string) => void
): PluginConfig {
  return {
    endpoints: sanitizeEndpoints(props.endpoints, warn),
    // A floor of 1s on the two knobs that drive network/CPU cadence keeps a
    // fat-fingered sub-second value from hammering app.signalk.retrieve()
    // (a full data-model walk) or flooding MarineTraffic/AISHub far past any
    // reasonable AIS reporting rate.
    pollIntervalSeconds: sanitizeRateSeconds(props.pollIntervalSeconds, 10, 1),
    minForwardIntervalSeconds: sanitizeRateSeconds(
      props.minForwardIntervalSeconds,
      10,
      1
    ),
    staticUpdateIntervalSeconds: sanitizeRateSeconds(
      props.staticUpdateIntervalSeconds,
      360,
      1
    ),
    // A floor here too: at the extreme (e.g. 0.001min = 60ms), a position
    // could never be fresh enough to forward -- not a flooding risk like
    // the two knobs above, but the opposite failure, total silent
    // starvation (targetsTracked stays 0 forever, no error anywhere).
    targetStalenessMinutes: sanitizeRateSeconds(
      props.targetStalenessMinutes,
      15,
      1
    )
  }
}

const createPlugin = function (appUntyped: ServerAPI) {
  const app = appUntyped as FullDataModelApp
  const error = app.error || ((msg: string) => console.error(msg))
  const debug = app.debug || ((msg: string) => console.log(msg))

  let udpSocket: dgram.Socket | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let statusTimer: NodeJS.Timeout | undefined
  let cfg: PluginConfig | undefined
  const stats = new Stats()
  const lastForwardAt = new Map<string, number>()
  const lastStaticAt = new Map<string, number>()
  let lastStartError: string | undefined

  function broadcast(nmea: string): void {
    const endpoints = cfg?.endpoints ?? []
    if (endpoints.length === 0 || !udpSocket) {
      // Nothing actually goes out -- don't count it as sent, or
      // messagesSentTotal/messagesSentLastMinute would keep climbing in the
      // status view even though every endpoint was dropped (e.g. by a typo
      // sanitizeEndpoints rejected), masking exactly the "silently stopped
      // forwarding" failure this status is meant to catch.
      debug(nmea)
      return
    }
    const line = nmea + '\n'
    const bytes = Buffer.byteLength(line)
    for (const endpoint of endpoints) {
      udpSocket.send(
        line,
        0,
        line.length,
        endpoint.port,
        endpoint.ipaddress,
        (err) => {
          if (err) {
            stats.noteSendError(endpoint, err.message)
            error(
              `send to ${endpoint.ipaddress}:${endpoint.port} failed: ${err.message}`
            )
          } else {
            stats.noteSend(endpoint, bytes)
          }
        }
      )
    }
    stats.noteMessageBroadcast(nmea)
    debug(nmea)
  }

  function buildDynamic(
    mmsi: string,
    vessel: VesselNode,
    aisClass: 'A' | 'B',
    position: Position
  ): TargetDynamic {
    return {
      mmsi,
      position,
      sog: getValue<number>(vessel, 'navigation.speedOverGround'),
      cog: getValue<number>(vessel, 'navigation.courseOverGroundTrue'),
      heading: resolveTrueHeadingRad(vessel),
      rateOfTurn: getValue<number>(vessel, 'navigation.rateOfTurn'),
      navState: getValue<string>(vessel, 'navigation.state'),
      aisClass
    }
  }

  function buildStatic(
    mmsi: string,
    vessel: VesselNode,
    aisClass: 'A' | 'B'
  ): TargetStatic {
    return {
      mmsi,
      aisClass,
      name: (vessel.name as string | undefined) ?? undefined,
      callsign: getValue<string>(vessel, 'communication.callsignVhf'),
      shipType: getValue<{ id?: number }>(vessel, 'design.aisShipType')?.id,
      length: getValue<{ overall?: number }>(vessel, 'design.length')?.overall,
      beam: getValue<number>(vessel, 'design.beam'),
      fromBow: getValue<number>(vessel, 'sensors.gps.fromBow'),
      fromCenter: getValue<number>(vessel, 'sensors.gps.fromCenter')
    }
  }

  function poll(): void {
    if (!cfg) return
    const now = Date.now()
    const stalenessMs = cfg.targetStalenessMinutes * 60_000
    const minForwardMs = cfg.minForwardIntervalSeconds * 1000
    const staticIntervalMs = cfg.staticUpdateIntervalSeconds * 1000

    const full = app.signalk.retrieve()
    const vessels = full.vessels ?? {}
    const activeMmsi = new Set<string>()

    for (const [context, vessel] of Object.entries(vessels)) {
      if (context === app.selfId) continue
      const mmsi = typeof vessel.mmsi === 'string' ? vessel.mmsi : undefined
      if (!mmsi) continue

      const positionNode = getNode(vessel, 'navigation.position')
      const position = positionNode?.value as Position | undefined
      if (
        !position ||
        !Number.isFinite(position.latitude) ||
        !Number.isFinite(position.longitude) ||
        isNullIsland(position)
      ) {
        continue
      }
      const positionAge = positionNode?.timestamp
        ? now - Date.parse(positionNode.timestamp)
        : NaN
      if (!Number.isFinite(positionAge) || positionAge > stalenessMs) continue

      const aisClass = classifyAis(positionNode?.pgn)
      activeMmsi.add(mmsi)
      stats.noteTargetSeen(mmsi, vessel.name as string | undefined, aisClass)

      const dueForPosition =
        now - (lastForwardAt.get(mmsi) ?? 0) >= minForwardMs
      if (dueForPosition) {
        const nmea = encodePositionReport(
          buildDynamic(mmsi, vessel, aisClass, position)
        )
        if (nmea) {
          broadcast(nmea)
          lastForwardAt.set(mmsi, now)
          stats.noteTargetForwarded(mmsi)
        }
      }

      const dueForStatic =
        now - (lastStaticAt.get(mmsi) ?? 0) >= staticIntervalMs
      if (dueForStatic) {
        const info = buildStatic(mmsi, vessel, aisClass)
        const messages =
          aisClass === 'A'
            ? [encodeStaticClassA(info, error)]
            : [
                encodeStaticClassBPartZero(info),
                encodeStaticClassBPartOne(info, error)
              ]
        // Broadcast every message that encoded, not just the first --
        // Array.some() would stop at the first truthy result, silently
        // dropping Class B's second sentence (ship type/callsign/
        // dimensions) whenever the first (the name) encodes successfully.
        let sentAny = false
        for (const nmea of messages) {
          if (!nmea) continue
          broadcast(nmea)
          sentAny = true
        }
        if (sentAny) lastStaticAt.set(mmsi, now)
      }
    }

    stats.pruneTargets(activeMmsi)
    for (const mmsi of Array.from(lastForwardAt.keys())) {
      if (!activeMmsi.has(mmsi)) {
        lastForwardAt.delete(mmsi)
        lastStaticAt.delete(mmsi)
      }
    }
  }

  function publishStatus(): void {
    if (!cfg) return
    const snapshot = stats.snapshot(plugin.started)
    const values = [
      {
        path: 'aisForwarder.status.targetsTracked',
        value: snapshot.targetsTracked
      },
      {
        path: 'aisForwarder.status.targetsSeenTotal',
        value: snapshot.targetsSeenTotal
      },
      {
        path: 'aisForwarder.status.messagesSentTotal',
        value: snapshot.messagesSentTotal
      },
      {
        path: 'aisForwarder.status.messagesSentLastMinute',
        value: snapshot.messagesSentLastMinute
      },
      {
        path: 'aisForwarder.status.lastForwardAgeSeconds',
        value: snapshot.lastForwardAgeSeconds
      },
      {
        path: 'aisForwarder.status.endpointsConfigured',
        value: snapshot.endpoints.length
      },
      {
        path: 'aisForwarder.status.endpointsWithErrors',
        value: snapshot.endpoints.filter((e) => e.lastError).length
      }
    ]
    const meta = [
      {
        path: 'aisForwarder.status.targetsTracked',
        value: {
          description:
            'AIS targets currently being relayed (fresh position within targetStalenessMinutes).'
        }
      },
      {
        path: 'aisForwarder.status.messagesSentLastMinute',
        value: {
          description:
            'AIS sentences handed to the UDP socket in the last 60s. No delivery ACK exists for UDP -- this only confirms local send, not receipt by the endpoint.'
        }
      },
      {
        path: 'aisForwarder.status.lastForwardAgeSeconds',
        value: {
          description:
            'Seconds since any AIS sentence was last sent to the configured endpoints.',
          units: 's'
        }
      }
    ]
    // handleMessage's Delta type brands `path`/`timestamp` as opaque
    // validated strings; a plugin has no way to mint those without a cast.
    app.handleMessage(plugin.id, {
      updates: [{ timestamp: new Date().toISOString(), values, meta }]
    } as unknown as Parameters<ServerAPI['handleMessage']>[1])
    app.setPluginStatus(
      `${snapshot.targetsTracked} Ziele aktiv, ${snapshot.messagesSentLastMinute} Msg/min, ${snapshot.endpoints.length} Endpunkt(e)` +
        (snapshot.lastError ? `, letzter Fehler: ${snapshot.lastError}` : '')
    )
  }

  const plugin: Plugin & { started: boolean } = {
    id: 'signalk-ais-forwarder',
    name: 'AIS Forwarder',
    description:
      'Forwards received AIS targets from the Signal K data model to UDP endpoints (MarineTraffic, AISHub, ...) so this vessel can act as a roaming AIS station',
    started: false,

    start: function (props: object) {
      lastStartError = undefined
      if (
        typeof app.signalk?.retrieve !== 'function' ||
        typeof app.selfId !== 'string'
      ) {
        const msg =
          'signalk-ais-forwarder not started: server is missing app.signalk.retrieve/app.selfId'
        error(msg)
        lastStartError = msg
        plugin.started = false
        return
      }

      cfg = readConfig(props as Record<string, unknown>, error)
      stats.syncEndpoints(cfg.endpoints)
      if (cfg.endpoints.length === 0) {
        debug(
          'no endpoints configured yet -- targets will be tracked but nothing sent'
        )
      }

      udpSocket = dgram.createSocket('udp4')
      // A socket-level fault (the ephemeral port bind on first send failing,
      // EMFILE, a transient network-stack error, ...) emits 'error' on the
      // socket itself, separately from any individual send()'s callback. An
      // EventEmitter with no 'error' listener throws on that event, and an
      // uncaught throw from a timer callback would crash the whole Signal K
      // server, not just this plugin.
      udpSocket.on('error', (err) => {
        error(`UDP socket error: ${err.message}`)
        // Not just a log line: without this, the plugin keeps looking
        // "started and healthy" in /status and setPluginStatus() even
        // though the socket broadcast() sends into is now likely broken.
        stats.noteSocketError(err.message)
      })
      pollTimer = setInterval(poll, cfg.pollIntervalSeconds * 1000)
      statusTimer = setInterval(publishStatus, 5000)
      plugin.started = true
      poll()
      publishStatus()
    },

    stop: function () {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
      if (statusTimer) {
        clearInterval(statusTimer)
        statusTimer = undefined
      }
      if (udpSocket) {
        udpSocket.close()
        udpSocket = undefined
      }
      lastForwardAt.clear()
      lastStaticAt.clear()
      cfg = undefined
      plugin.started = false
    },

    statusMessage: function () {
      if (lastStartError !== undefined) return lastStartError
      const snapshot = stats.snapshot(plugin.started)
      return `${snapshot.targetsTracked} targets, ${snapshot.messagesSentLastMinute} msg/min, ${snapshot.endpoints.length} endpoint(s)`
    },

    registerWithRouter: function (router: PluginRouter) {
      const statusHandler = (
        _req: unknown,
        res: { json: (body: unknown) => void }
      ) => {
        res.json(stats.snapshot(plugin.started))
      }
      type Registrar = { get: (path: string, handler: typeof statusHandler) => unknown }
      // router.access() is declared in @signalk/server-api's types but not
      // implemented by every server build using that same types version
      // (observed: server-api 2.31.1 with a core that throws
      // "router.access is not a function"). An uncaught throw here aborts
      // this plugin's admin registration entirely -- including the
      // enable/disable config route -- so this must never throw, whether
      // router.access is missing or present-but-throws. Resolve which
      // object to register against first, then register exactly once --
      // a single call site means '/status' can never end up registered
      // twice, regardless of which fallback path is taken.
      let target: Registrar = router
      if (typeof router.access === 'function') {
        try {
          target = router.access('readonly')
        } catch (err) {
          error(
            `router.access threw, falling back to an unauthenticated /status route: ${(err as Error).message}`
          )
        }
      } else {
        debug(
          'router.access unavailable on this server build -- registering /status without readonly access scoping'
        )
      }
      target.get('/status', statusHandler)
    },

    schema: {
      type: 'object',
      properties: {
        endpoints: {
          type: 'array',
          title: 'UDP endpoints to send updates',
          items: {
            type: 'object',
            required: ['ipaddress', 'port'],
            properties: {
              ipaddress: {
                type: 'string',
                title: 'UDP endpoint IP address or hostname',
                default: 'listener.marinetraffic.com'
              },
              port: {
                type: 'number',
                title: 'Port',
                default: 14577
              }
            }
          }
        },
        pollIntervalSeconds: {
          type: 'number',
          title:
            'How often to scan the Signal K data model for AIS targets (s)',
          default: 10,
          minimum: 1
        },
        minForwardIntervalSeconds: {
          type: 'number',
          title: 'Minimum time between position forwards per target (s)',
          default: 10,
          minimum: 1
        },
        staticUpdateIntervalSeconds: {
          type: 'number',
          title: 'Static/voyage data resend interval per target (s)',
          default: 360,
          minimum: 1
        },
        targetStalenessMinutes: {
          type: 'number',
          title:
            'Stop forwarding a target once its position is older than this (min)',
          default: 15,
          minimum: 1
        }
      }
    }
  }

  return plugin
}

export = createPlugin
