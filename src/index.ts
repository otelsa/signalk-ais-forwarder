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
 * Instead it subscribes to the Signal K delta stream, mirrors vessel
 * state locally, and re-encodes each received vessel's position into an
 * AIS sentence. This works regardless of whether the original AIS traffic
 * arrived via N2K, serial NMEA0183, another plugin, or a Signal
 * K-to-Signal K link from a second server -- and it keeps working across
 * an upstream server restart, since the subscription is local and simply
 * goes quiet while the far end is away.
 *
 * Own-vessel position reporting is optional (see the `ownVessel` config
 * group, off by default) and reuses the exact same encode.ts functions
 * as target forwarding. It exists so a host that already runs this
 * plugin for targets doesn't need @signalk/aisreporter installed too
 * just to also report its own position -- both can still run side by
 * side (e.g. on different hosts, or with different endpoint sets) if
 * that's preferable; this is additive, not a replacement.
 */

import * as dgram from 'dgram'
import type {
  Context,
  Delta,
  Path,
  Plugin,
  PluginRouter,
  Position,
  ServerAPI,
  Unsubscribes
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

// selfId is a real, widely-used server property that is not part of the
// published ServerAPI types (see the "typing is incomplete" note in
// @signalk/server-api). Declared locally rather than patched into
// node_modules.
interface AisForwarderApp extends ServerAPI {
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

// Signal K reports the transponder class on `sensors.ais.class` ('A', 'B'
// or 'BASE' for shore base stations), independent of whether the target
// arrived over N2K, serial NMEA0183, or a Signal K-to-Signal K link. This
// deliberately does not look at the N2K PGN that tagged the delta: on a
// server fed by another Signal K server that N2K metadata may be absent
// or reshaped, and the class is data we are given directly anyway.
// Anything unknown falls back to Class B, which keeps the encoded
// sentence valid without having to invent a nav status.
function classifyAis(aisClass: unknown): 'A' | 'B' {
  return aisClass === 'A' ? 'A' : 'B'
}

// Base stations and ATONs share the vessels-shaped delta plumbing but are
// not vessels, and must never be relayed as one.
function isRelayableTarget(aisClass: unknown): boolean {
  return aisClass === undefined || aisClass === 'A' || aisClass === 'B'
}

interface OwnVesselConfig {
  enabled: boolean
  positionRateSeconds: number
  staticRateSeconds: number
  sendLastKnownPosition: boolean
  lastKnownPositionRateSeconds: number
}

interface PluginConfig {
  endpoints: Endpoint[]
  pollIntervalSeconds: number
  minForwardIntervalSeconds: number
  staticUpdateIntervalSeconds: number
  targetStalenessMinutes: number
  ownVessel: OwnVesselConfig
}

function readOwnVesselConfig(raw: unknown): OwnVesselConfig {
  const props = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  return {
    enabled: props.enabled === true,
    // Defaults mirror @signalk/aisreporter's own defaults (60s/360s/180s)
    // -- self-reporting to an aggregator conventionally runs much slower
    // than target tracking's 10s default, so this gets its own knobs
    // rather than reusing pollIntervalSeconds/staticUpdateIntervalSeconds.
    positionRateSeconds: sanitizeRateSeconds(props.positionRateSeconds, 60, 1),
    staticRateSeconds: sanitizeRateSeconds(props.staticRateSeconds, 360, 1),
    sendLastKnownPosition: props.sendLastKnownPosition === true,
    lastKnownPositionRateSeconds: sanitizeRateSeconds(
      props.lastKnownPositionRateSeconds,
      180,
      1
    )
  }
}

function readConfig(
  props: Record<string, unknown>,
  warn: (msg: string) => void
): PluginConfig {
  return {
    endpoints: sanitizeEndpoints(props.endpoints, warn),
    // A floor of 1s on the two knobs that drive network/CPU cadence keeps a
    // fat-fingered sub-second value from walking the whole vessel mirror
    // on a tight loop, or flooding MarineTraffic/AISHub far past any
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
    ),
    ownVessel: readOwnVesselConfig(props.ownVessel)
  }
}

const createPlugin = function (appUntyped: ServerAPI) {
  const app = appUntyped as AisForwarderApp
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

  // Vessel state, mirrored from the delta stream in the same shape the
  // full data model uses ({ value, timestamp } leaves under dotted
  // paths), so every reader below (buildDynamic/buildStatic/
  // resolveTrueHeadingRad/own-vessel) works unchanged.
  //
  // Deltas rather than app.signalk.retrieve() because the full model is
  // not always populated: on a server fed by another Signal K server over
  // a Signal K-to-Signal K connection, a core bug in
  // handleNmea2000Source() throws on the mirrored N2K source metadata and
  // the delta is dropped before it ever reaches the full model, leaving
  // vessels present but position-less. The delta stream itself is
  // unaffected. Reading deltas also means an upstream server restart just
  // pauses the flow: the subscription is local to this server, nothing
  // needs reconnecting here, and entries age out via
  // targetStalenessMinutes on their own.
  const vessels = new Map<string, VesselNode>()
  let unsubscribes: Unsubscribes = []

  // Delta paths are remote input: a crafted path segment could otherwise
  // walk into Object.prototype while building the nested mirror.
  const FORBIDDEN_PATH_SEGMENTS = new Set([
    '__proto__',
    'constructor',
    'prototype'
  ])

  function storeValue(
    vessel: VesselNode,
    path: string,
    value: unknown,
    timestamp: string
  ): void {
    const parts = path.split('.')
    if (parts.some((p) => p.length === 0 || FORBIDDEN_PATH_SEGMENTS.has(p))) {
      return
    }
    let cursor = vessel as Record<string, unknown>
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i] as string
      const next = cursor[key]
      if (typeof next !== 'object' || next === null) cursor[key] = {}
      cursor = cursor[key] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1] as string] = { value, timestamp }
  }

  // A delta with an empty path carries vessel-level attributes (mmsi,
  // name, ...) as a plain nested object rather than a value leaf.
  function storeVesselAttributes(vessel: VesselNode, value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    for (const [key, attr] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key)) continue
      if (typeof attr === 'string' || typeof attr === 'number') {
        vessel[key] = attr
      }
    }
  }

  function handleDelta(delta: Delta): void {
    const context = delta.context
    if (typeof context !== 'string' || !context.startsWith('vessels.')) return
    const id = context.slice('vessels.'.length)
    let vessel = vessels.get(id)
    if (!vessel) {
      vessel = {}
      vessels.set(id, vessel)
    }
    for (const update of delta.updates ?? []) {
      const timestamp =
        typeof update.timestamp === 'string'
          ? update.timestamp
          : new Date().toISOString()
      for (const pathValue of update.values ?? []) {
        if (pathValue.path === '') {
          storeVesselAttributes(vessel, pathValue.value)
        } else if (typeof pathValue.path === 'string') {
          storeValue(vessel, pathValue.path, pathValue.value, timestamp)
        }
      }
    }
  }

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
      // AIS targets report the transponder's antenna offsets under
      // sensors.ais.*; sensors.gps.* is where a vessel's own GPS offsets
      // live. Own-vessel reporting supplies the latter, targets the
      // former, so accept whichever is present.
      fromBow:
        getValue<number>(vessel, 'sensors.ais.fromBow') ??
        getValue<number>(vessel, 'sensors.gps.fromBow'),
      fromCenter:
        getValue<number>(vessel, 'sensors.ais.fromCenter') ??
        getValue<number>(vessel, 'sensors.gps.fromCenter')
    }
  }

  function poll(): void {
    if (!cfg) return
    const now = Date.now()
    const stalenessMs = cfg.targetStalenessMinutes * 60_000
    const minForwardMs = cfg.minForwardIntervalSeconds * 1000
    const staticIntervalMs = cfg.staticUpdateIntervalSeconds * 1000

    const activeMmsi = new Set<string>()

    for (const [context, vessel] of vessels) {
      if (context === app.selfId) continue
      const mmsi = typeof vessel.mmsi === 'string' ? vessel.mmsi : undefined
      if (!mmsi) continue

      const reportedClass = getValue<unknown>(vessel, 'sensors.ais.class')
      if (!isRelayableTarget(reportedClass)) continue

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

      const aisClass = classifyAis(reportedClass)
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
    pruneVesselMirror(now, stalenessMs)
  }

  // The mirror is fed by deltas and nothing removes entries on its own, so
  // a long-running server would otherwise accumulate every vessel it ever
  // heard of. Self is kept regardless: own-vessel reporting needs it even
  // while the position is stale (that is what sendLastKnownPosition is
  // for), and there is only ever one of it.
  function pruneVesselMirror(now: number, stalenessMs: number): void {
    for (const [context, vessel] of vessels) {
      if (context === app.selfId) continue
      const timestamp = getNode(vessel, 'navigation.position')?.timestamp
      const age = timestamp ? now - Date.parse(timestamp) : NaN
      if (!Number.isFinite(age) || age > stalenessMs) {
        vessels.delete(context)
      }
    }
  }

  // Own-vessel reporting state. Single-value, not a Map keyed by mmsi like
  // the target maps above -- there is exactly one self.
  let ownVesselLastForwardAt = 0
  let ownVesselLastStaticAt = 0
  let ownVesselLastKnownSentAt = 0
  let ownVesselLastGoodNmea: string | undefined
  let ownVesselFirstPositionSeen = false
  let ownVesselMissingMmsiWarned = false

  // Mirrors @signalk/aisreporter's own tick()/sendStaticReport()/
  // sendLastPositionReport() behaviour, but folded into this plugin's
  // existing poll-driven architecture (one interval, due-ness checked
  // per call) instead of three separate setInterval timers, and built
  // on the same encode.ts functions target forwarding already uses --
  // always reported as Class B (aisreporter never supported Class A
  // self-reporting either; a vessel with a real Class A transponder
  // already broadcasts over RF and has no need for this).
  function pollOwnVessel(): void {
    if (!cfg?.ownVessel.enabled) return
    const now = Date.now()
    const self = vessels.get(app.selfId)
    if (!self) return

    const mmsi =
      getValue<string>(self, 'mmsi') ?? (self.mmsi as string | undefined)
    if (!mmsi) {
      if (!ownVesselMissingMmsiWarned) {
        error(
          'ownVessel.enabled is on but this vessel has no mmsi configured -- own-vessel reporting will not start until one is set'
        )
        ownVesselMissingMmsiWarned = true
      }
      return
    }

    const positionNode = getNode(self, 'navigation.position')
    const position = positionNode?.value as Position | undefined
    const hasFreshPosition =
      !!position &&
      Number.isFinite(position.latitude) &&
      Number.isFinite(position.longitude) &&
      !isNullIsland(position)

    let sentFreshThisTick = false
    if (
      hasFreshPosition &&
      now - ownVesselLastForwardAt >= cfg.ownVessel.positionRateSeconds * 1000
    ) {
      const nmea = encodePositionReport(
        buildDynamic(mmsi, self, 'B', position as Position)
      )
      if (nmea) {
        broadcast(nmea)
        ownVesselLastForwardAt = now
        ownVesselLastGoodNmea = nmea
        sentFreshThisTick = true
        // Announce a fresh vessel to aggregators immediately on its first
        // real dynamic reading, same as aisreporter -- force the static
        // report below to fire on this same tick rather than waiting a
        // full staticRateSeconds.
        if (!ownVesselFirstPositionSeen) {
          ownVesselFirstPositionSeen = true
          ownVesselLastStaticAt = 0
        }
      }
    }

    // Keep pinging the last good fix at a slower cadence while anchored/
    // GPS-lost, so the vessel doesn't silently vanish from trackers.
    // Never fires ahead of a fresh send in the same tick -- a fresh
    // position already carries newer information than a replay of the
    // last one would.
    if (
      cfg.ownVessel.sendLastKnownPosition &&
      !sentFreshThisTick &&
      ownVesselLastGoodNmea !== undefined &&
      now - ownVesselLastKnownSentAt >=
        cfg.ownVessel.lastKnownPositionRateSeconds * 1000
    ) {
      broadcast(ownVesselLastGoodNmea)
      ownVesselLastKnownSentAt = now
    }

    if (
      ownVesselFirstPositionSeen &&
      now - ownVesselLastStaticAt >= cfg.ownVessel.staticRateSeconds * 1000
    ) {
      const info = buildStatic(mmsi, self, 'B')
      const messages = [
        encodeStaticClassBPartZero(info),
        encodeStaticClassBPartOne(info, error)
      ]
      let sentAny = false
      for (const nmea of messages) {
        if (!nmea) continue
        broadcast(nmea)
        sentAny = true
      }
      if (sentAny) ownVesselLastStaticAt = now
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
      },
      {
        path: 'aisForwarder.status.ownVesselEnabled',
        value: cfg.ownVessel.enabled
      },
      {
        path: 'aisForwarder.status.ownVesselLastPositionAgeSeconds',
        value:
          cfg.ownVessel.enabled && ownVesselLastForwardAt
            ? Math.round((Date.now() - ownVesselLastForwardAt) / 1000)
            : null
      }
    ]
    const meta = [
      {
        path: 'aisForwarder.status.ownVesselLastPositionAgeSeconds',
        value: {
          description:
            "Seconds since this vessel's own position was last reported. null until ownVessel reporting is enabled and has sent a first position.",
          units: 's'
        }
      },
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
        (cfg.ownVessel.enabled
          ? `, eigenes Schiff: ${ownVesselLastForwardAt ? Math.round((Date.now() - ownVesselLastForwardAt) / 1000) + 's her' : 'noch keine Position'}`
          : '') +
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
        typeof app.subscriptionmanager?.subscribe !== 'function' ||
        typeof app.selfId !== 'string'
      ) {
        const msg =
          'signalk-ais-forwarder not started: server is missing app.subscriptionmanager/app.selfId'
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
      // minPeriod throttles per path so a busy bus can't fire the handler
      // thousands of times between polls; the mirror only needs to be
      // current by the next poll tick, not instantaneous.
      unsubscribes = []
      app.subscriptionmanager.subscribe(
        {
          context: '*' as Context,
          subscribe: [{ path: '*' as Path, policy: 'instant', minPeriod: 1000 }]
        },
        unsubscribes,
        (err: unknown) => {
          error(`subscription error: ${err}`)
        },
        handleDelta
      )

      pollTimer = setInterval(() => {
        poll()
        pollOwnVessel()
      }, cfg.pollIntervalSeconds * 1000)
      statusTimer = setInterval(publishStatus, 5000)
      plugin.started = true
      poll()
      pollOwnVessel()
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
      unsubscribes.forEach((f) => {
        try {
          f()
        } catch (err) {
          debug(`unsubscribe failed (ignored): ${err}`)
        }
      })
      unsubscribes = []
      vessels.clear()
      lastForwardAt.clear()
      lastStaticAt.clear()
      ownVesselLastForwardAt = 0
      ownVesselLastStaticAt = 0
      ownVesselLastKnownSentAt = 0
      ownVesselLastGoodNmea = undefined
      ownVesselFirstPositionSeen = false
      ownVesselMissingMmsiWarned = false
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
      type Registrar = {
        get: (path: string, handler: typeof statusHandler) => unknown
      }
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
        },
        ownVessel: {
          type: 'object',
          title: 'Own-vessel reporting',
          description:
            "Also report this vessel's own position/static data to the endpoints above, the same functionality @signalk/aisreporter provides -- off by default so installing this plugin never changes existing self-reporting setups. Uses this vessel's own mmsi (server settings), and always reports as AIS Class B.",
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Enable own-vessel reporting',
              default: false
            },
            positionRateSeconds: {
              type: 'number',
              title: 'Own-vessel position report rate (s)',
              default: 60,
              minimum: 1
            },
            staticRateSeconds: {
              type: 'number',
              title: 'Own-vessel static/voyage data resend interval (s)',
              default: 360,
              minimum: 1
            },
            sendLastKnownPosition: {
              type: 'boolean',
              title:
                'Keep sending the last known position when a fresh position is not available (e.g. anchored, GPS lost)',
              default: false
            },
            lastKnownPositionRateSeconds: {
              type: 'number',
              title: 'Last-known-position resend rate (s)',
              default: 180,
              minimum: 1
            }
          }
        }
      }
    }
  }

  return plugin
}

export = createPlugin
