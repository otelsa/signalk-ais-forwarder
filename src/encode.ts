/*
 * Portions of this file (the SOG/COG/heading field mapping and the
 * endpoint/rate sanitizing helpers) are adapted from SignalK/aisreporter
 * (Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>, Apache-2.0), which
 * this plugin is a fork of. See README.md for full attribution.
 */

import { AisEncode } from 'ggencoder'
import type { Position } from '@signalk/server-api'

export interface Endpoint {
  ipaddress: string
  port: number
}

// AIS "not available" sentinels (decoded form; ggencoder scales to the
// on-the-wire values). See ITU-R M.1371.
const AIS_SOG_NOT_AVAILABLE_KN = 102.3
const AIS_COG_NOT_AVAILABLE_DEG = 360
const AIS_HEADING_NOT_AVAILABLE = 511
const AIS_ROT_NOT_AVAILABLE = -128
const AIS_NAVSTATUS_NOT_DEFINED = 15

export function radsToDeg(radians: number): number {
  return (radians * 180) / Math.PI
}

export function mpsToKn(mps: number): number {
  return 1.9438444924574 * mps
}

export function sogToAisField(sogMps: number | undefined): number {
  if (sogMps === undefined) return AIS_SOG_NOT_AVAILABLE_KN
  return mpsToKn(sogMps)
}

export function cogToAisField(cogRad: number | undefined): number {
  if (cogRad === undefined) return AIS_COG_NOT_AVAILABLE_DEG
  return ((radsToDeg(cogRad) % 360) + 360) % 360
}

export function headingToAisField(headingRad: number | undefined): number {
  if (headingRad === undefined) return AIS_HEADING_NOT_AVAILABLE
  return ((radsToDeg(headingRad) % 360) + 360) % 360
}

// ITU-R M.1371 ROT field: signed 8-bit, encoded as
// ROT_AIS = round(4.733 * sqrt(|ROT_source in deg/min|)), sign per turn
// direction, clamped to +/-126. -128 signals "no turn information".
export function rotToAisField(rateOfTurnRadPerSec: number | undefined): number {
  if (
    rateOfTurnRadPerSec === undefined ||
    !Number.isFinite(rateOfTurnRadPerSec)
  ) {
    return AIS_ROT_NOT_AVAILABLE
  }
  const degPerMin = radsToDeg(rateOfTurnRadPerSec) * 60
  if (degPerMin === 0) return 0
  const magnitude = Math.min(
    126,
    Math.round(4.733 * Math.sqrt(Math.abs(degPerMin)))
  )
  return degPerMin > 0 ? magnitude : -magnitude
}

// Signal K's navigation.state enum (see @signalk/signalk-schema
// groups/navigation.json) is richer than the 16-value AIS navigational
// status field, so this is a many-to-one mapping. Anything unmapped
// (including a missing/unknown state) falls back to 15 "not defined",
// which is the correct AIS default rather than a fabricated 0
// ("under way using engine").
const NAV_STATE_TO_AIS_STATUS: Readonly<Record<string, number>> = {
  motoring: 0,
  anchored: 1,
  'not under command': 2,
  'restricted manouverability': 3,
  'restricted manouverability towing < 200m': 3,
  'restricted manouverability towing > 200m': 3,
  'restricted manouverability underwater operations': 3,
  'mine clearance': 3,
  'constrained by draft': 4,
  moored: 5,
  aground: 6,
  fishing: 7,
  'fishing-hampered': 7,
  trawling: 7,
  'trawling-shooting': 7,
  'trawling-hauling': 7,
  sailing: 8,
  'Reserved for future amendment of Navigational Status for HSC': 9,
  'Reserved for future amendment of Navigational Status for WIG': 10,
  'towing < 200m': 11,
  'towing > 200m': 11,
  pushing: 12,
  'Reserved for future use-13': 13,
  'Reserved for future use-14': 14
}

export function navStateToAisStatus(state: string | undefined): number {
  if (state === undefined) return AIS_NAVSTATUS_NOT_DEFINED
  return NAV_STATE_TO_AIS_STATUS[state] ?? AIS_NAVSTATUS_NOT_DEFINED
}

// Some GPS / AIS sources emit (0, 0) as a sentinel when they have no fix.
// 1e-6 degrees is ~11cm at the equator -- anything below that is noise
// around zero, not a real fix.
const NULL_ISLAND_EPSILON_DEG = 1e-6
export function isNullIsland(position: Position): boolean {
  return (
    Math.abs(position.latitude) < NULL_ISLAND_EPSILON_DEG &&
    Math.abs(position.longitude) < NULL_ISLAND_EPSILON_DEG
  )
}

export interface TargetDynamic {
  mmsi: string
  position: Position
  sog?: number
  cog?: number
  heading?: number
  rateOfTurn?: number
  navState?: string
  aisClass: 'A' | 'B'
}

// Class A: type 1 position report (nav status + rate of turn). Class B:
// type 18 (no nav status/ROT field in the AIS spec for class B).
export function encodePositionReport(
  target: TargetDynamic
): string | undefined {
  const common = {
    mmsi: target.mmsi,
    repeat: 0,
    sog: sogToAisField(target.sog),
    accuracy: 0, // 0 = regular GPS, 1 = DGPS
    lon: target.position.longitude,
    lat: target.position.latitude,
    cog: cogToAisField(target.cog),
    hdg: headingToAisField(target.heading)
  }
  const encoded =
    target.aisClass === 'A'
      ? new AisEncode({
          ...common,
          aistype: 1,
          navstatus: navStateToAisStatus(target.navState),
          rot: rotToAisField(target.rateOfTurn)
        })
      : new AisEncode({ ...common, aistype: 18 })
  return encoded.valid ? encoded.nmea : undefined
}

export interface TargetStatic {
  mmsi: string
  aisClass: 'A' | 'B'
  name?: string
  callsign?: string
  shipType?: number
  length?: number
  beam?: number
  fromBow?: number
  fromCenter?: number
}

function putDimensions(
  length: number | undefined,
  beam: number | undefined,
  fromBow: number | undefined,
  fromCenter: number | undefined,
  warn?: (msg: string) => void
): { dimA: string; dimB: string; dimC: string; dimD: string } {
  const l = length ?? 0
  const b = beam ?? 0
  const bow = fromBow ?? 0
  const center = fromCenter ?? 0
  const rawDimB = l - bow
  const rawDimC = b / 2 + center
  const rawDimD = b / 2 - center
  // Clamped to 0: a miscalibrated fromBow/fromCenter config value (e.g.
  // fromBow > length) would otherwise go negative here, and ggencoder packs
  // a negative dimension as its two's-complement bit pattern -- a huge
  // "valid" positive dimension on the wire instead of an error. Warn
  // (rather than silently reporting a plausible-looking 0) so the
  // underlying config inconsistency doesn't go unnoticed indefinitely --
  // matching how sanitizeEndpoints() reports a rejected value below.
  if (warn && (bow < 0 || rawDimB < 0 || rawDimC < 0 || rawDimD < 0)) {
    warn(
      `clamping an out-of-range ship dimension to 0 (length=${l}, beam=${b}, fromBow=${bow}, fromCenter=${center}) -- check design.length/design.beam/sensors.gps.fromBow/fromCenter for an inconsistency`
    )
  }
  return {
    dimA: Math.max(0, bow).toFixed(0),
    dimB: Math.max(0, rawDimB).toFixed(0),
    dimC: Math.max(0, rawDimC).toFixed(0),
    dimD: Math.max(0, rawDimD).toFixed(0)
  }
}

// Class A static & voyage data (type 5). Only emitted when there's at
// least a name or callsign, matching aisreporter's gating for self.
export function encodeStaticClassA(
  target: TargetStatic,
  warn?: (msg: string) => void
): string | undefined {
  if (!target.name && !target.callsign) return undefined
  const dims = putDimensions(
    target.length,
    target.beam,
    target.fromBow,
    target.fromCenter,
    warn
  )
  const encoded = new AisEncode({
    mmsi: target.mmsi,
    aistype: 5,
    repeat: 0,
    callsign: target.callsign,
    shipname: target.name,
    cargo: target.shipType,
    ...dims
  })
  return encoded.valid ? encoded.nmea : undefined
}

// Class B static data (type 24), sent as two parts like aisreporter does
// for self: part 0 carries the name, part 1 the rest.
export function encodeStaticClassBPartZero(
  target: TargetStatic
): string | undefined {
  if (!target.name) return undefined
  const encoded = new AisEncode({
    aistype: 24,
    repeat: 0,
    part: 0,
    mmsi: target.mmsi,
    shipname: target.name
  })
  return encoded.valid ? encoded.nmea : undefined
}

export function encodeStaticClassBPartOne(
  target: TargetStatic,
  warn?: (msg: string) => void
): string | undefined {
  if (
    target.shipType === undefined &&
    !target.callsign &&
    (target.length === undefined ||
      target.beam === undefined ||
      target.fromBow === undefined ||
      target.fromCenter === undefined)
  ) {
    return undefined
  }
  const dims = putDimensions(
    target.length,
    target.beam,
    target.fromBow,
    target.fromCenter,
    warn
  )
  const encoded = new AisEncode({
    aistype: 24,
    repeat: 0,
    part: 1,
    mmsi: target.mmsi,
    cargo: target.shipType,
    callsign: target.callsign,
    ...dims
  })
  return encoded.valid ? encoded.nmea : undefined
}

// Drop endpoints whose ipaddress or port can't be safely passed to
// dgram.send. Adapted from aisreporter's sanitizeEndpoints.
export function sanitizeEndpoints(
  endpoints: unknown,
  warn: (msg: string) => void
): Endpoint[] {
  if (!Array.isArray(endpoints)) return []
  const result: Endpoint[] = []
  for (const ep of endpoints) {
    if (!ep || typeof ep !== 'object') {
      warn(`ignoring endpoint, not an object: ${JSON.stringify(ep)}`)
      continue
    }
    const candidate = ep as { ipaddress?: unknown; port?: unknown }
    if (
      typeof candidate.ipaddress !== 'string' ||
      candidate.ipaddress.length === 0 ||
      /[\r\n]/.test(candidate.ipaddress)
    ) {
      warn(
        `ignoring endpoint with invalid ipaddress: ${JSON.stringify(candidate.ipaddress)}`
      )
      continue
    }
    if (
      typeof candidate.port !== 'number' ||
      !Number.isInteger(candidate.port) ||
      candidate.port < 1 ||
      candidate.port > 65535
    ) {
      warn(
        `ignoring endpoint with invalid port: ${JSON.stringify(candidate.port)}`
      )
      continue
    }
    result.push({ ipaddress: candidate.ipaddress, port: candidate.port })
  }
  return result
}

// Keep operator-typo configs (NaN, negatives, strings) from arming a
// pathologically tight interval. Adapted from aisreporter's
// sanitizeRateSeconds.
export function sanitizeRateSeconds(
  value: unknown,
  defaultSeconds: number,
  minSeconds = 0
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return defaultSeconds
  }
  return Math.max(minSeconds, value)
}
