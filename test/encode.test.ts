import { expect } from 'chai'
import { AisDecode } from 'ggencoder'
import {
  cogToAisField,
  encodePositionReport,
  encodeStaticClassA,
  encodeStaticClassBPartOne,
  encodeStaticClassBPartZero,
  headingToAisField,
  isNullIsland,
  navStateToAisStatus,
  rotToAisField,
  sanitizeEndpoints,
  sanitizeRateSeconds,
  sogToAisField,
  type TargetDynamic,
  type TargetStatic
} from '../src/encode'

describe('field mapping', () => {
  it('reports SOG/COG/heading not-available sentinels when unknown', () => {
    expect(sogToAisField(undefined)).to.equal(102.3)
    expect(cogToAisField(undefined)).to.equal(360)
    expect(headingToAisField(undefined)).to.equal(511)
  })

  it('converts m/s to the knots field ggencoder expects', () => {
    expect(sogToAisField(5)).to.be.closeTo(9.719, 0.001)
  })

  it('normalizes course/heading in radians into [0, 360) degrees', () => {
    expect(cogToAisField(0)).to.equal(0)
    expect(cogToAisField(Math.PI)).to.be.closeTo(180, 0.001)
    expect(headingToAisField(-Math.PI / 2)).to.be.closeTo(270, 0.001)
  })

  it('returns -128 (not available) for undefined rate of turn', () => {
    expect(rotToAisField(undefined)).to.equal(-128)
  })

  it('returns 0 for a zero rate of turn', () => {
    expect(rotToAisField(0)).to.equal(0)
  })

  it('encodes rate of turn per the ITU-R M.1371 formula, clamped to +/-126', () => {
    // 4.733 * sqrt(deg/min), signed by turn direction
    const oneDegPerSecStarboard = (1 * Math.PI) / 180 // rad/s
    expect(rotToAisField(oneDegPerSecStarboard)).to.be.closeTo(
      Math.round(4.733 * Math.sqrt(60)),
      0
    )
    expect(rotToAisField(-oneDegPerSecStarboard)).to.equal(
      -rotToAisField(oneDegPerSecStarboard)
    )
    const extremeRate = (30 * Math.PI) / 180 // 30 deg/s, way past the clamp
    expect(rotToAisField(extremeRate)).to.equal(126)
  })

  it('maps known Signal K navigation states to their AIS status code', () => {
    expect(navStateToAisStatus('motoring')).to.equal(0)
    expect(navStateToAisStatus('anchored')).to.equal(1)
    expect(navStateToAisStatus('moored')).to.equal(5)
    expect(navStateToAisStatus('fishing')).to.equal(7)
    expect(navStateToAisStatus('sailing')).to.equal(8)
  })

  it('falls back to 15 (not defined) for unknown or missing nav state', () => {
    expect(navStateToAisStatus(undefined)).to.equal(15)
    expect(navStateToAisStatus('some-future-state')).to.equal(15)
  })

  it('treats a near-zero position as Null Island, not a real fix', () => {
    expect(isNullIsland({ latitude: 0, longitude: 0 })).to.equal(true)
    expect(isNullIsland({ latitude: 54.35, longitude: 18.65 })).to.equal(false)
  })
})

describe('encodePositionReport', () => {
  const baseTarget: TargetDynamic = {
    mmsi: '211234567',
    position: { latitude: 54.352, longitude: 18.6466 },
    sog: 3.5,
    cog: 1.2,
    heading: 1.25,
    aisClass: 'B'
  }

  it('produces a decodable Class B (type 18) sentence by default', () => {
    const nmea = encodePositionReport(baseTarget)
    expect(nmea).to.be.a('string')
    const decoded = new AisDecode(nmea as string)
    expect(decoded.valid).to.equal(true)
    expect(decoded.aistype).to.equal(18)
    expect(decoded.mmsi).to.equal('211234567')
    expect(decoded.lat).to.be.closeTo(54.352, 0.001)
    expect(decoded.lon).to.be.closeTo(18.6466, 0.001)
  })

  it('produces a decodable Class A (type 1) sentence with nav status and ROT', () => {
    const nmea = encodePositionReport({
      ...baseTarget,
      aisClass: 'A',
      navState: 'moored',
      rateOfTurn: 0
    })
    const decoded = new AisDecode(nmea as string)
    expect(decoded.valid).to.equal(true)
    expect(decoded.aistype).to.equal(1)
    expect(decoded.navstatus).to.equal(5) // moored
    expect(decoded.rot).to.equal(0)
  })
})

describe('static data', () => {
  const info: TargetStatic = {
    mmsi: '211234567',
    aisClass: 'B',
    name: 'Test Vessel',
    callsign: 'DA1234',
    shipType: 37,
    length: 12,
    beam: 4,
    fromBow: 6,
    fromCenter: 0
  }

  it('omits Class A static data when there is no name or callsign', () => {
    expect(
      encodeStaticClassA({ ...info, name: undefined, callsign: undefined })
    ).to.be.undefined
  })

  it('encodes a decodable Class A static/voyage sentence (type 5)', () => {
    const nmea = encodeStaticClassA({ ...info, aisClass: 'A' })
    const decoded = new AisDecode(nmea as string)
    expect(decoded.valid).to.equal(true)
    expect(decoded.aistype).to.equal(5)
    expect(decoded.shipname).to.equal('TEST VESSEL')
    expect(decoded.callsign).to.equal('DA1234')
  })

  it('encodes decodable Class B static sentences (type 24, parts 0 and 1)', () => {
    const partZero = encodeStaticClassBPartZero(info)
    const partOne = encodeStaticClassBPartOne(info)
    const decodedZero = new AisDecode(partZero as string)
    const decodedOne = new AisDecode(partOne as string)
    expect(decodedZero.aistype).to.equal(24)
    expect(decodedZero.shipname).to.equal('TEST VESSEL')
    expect(decodedOne.aistype).to.equal(24)
    expect(decodedOne.callsign).to.equal('DA1234')
  })

  it('omits Class B part 1 when there is nothing worth sending', () => {
    expect(
      encodeStaticClassBPartOne({
        mmsi: '211234567',
        aisClass: 'B',
        name: 'x'
      })
    ).to.be.undefined
  })

  it('sends Class B part 1 when only shipType is present, even with no dimensions', () => {
    const nmea = encodeStaticClassBPartOne({
      mmsi: '211234567',
      aisClass: 'B',
      name: 'x',
      shipType: 37
    })
    expect(nmea).to.be.a('string')
  })

  it('sends Class B part 1 when only callsign is present, even with no dimensions', () => {
    const nmea = encodeStaticClassBPartOne({
      mmsi: '211234567',
      aisClass: 'B',
      name: 'x',
      callsign: 'DA1234'
    })
    expect(nmea).to.be.a('string')
  })

  it('sends Class B part 1 when all four dimension fields are present but nothing else is', () => {
    const nmea = encodeStaticClassBPartOne({
      mmsi: '211234567',
      aisClass: 'B',
      name: 'x',
      length: 12,
      beam: 4,
      fromBow: 6,
      fromCenter: 0
    })
    expect(nmea).to.be.a('string')
  })

  it('omits Class B part 1 when only some, not all, dimension fields are present', () => {
    expect(
      encodeStaticClassBPartOne({
        mmsi: '211234567',
        aisClass: 'B',
        name: 'x',
        length: 12,
        beam: 4
        // fromBow/fromCenter missing -- an incomplete dimension set is
        // treated the same as none at all, not padded with zeros.
      })
    ).to.be.undefined
  })

  it('clamps a negative dimension (fromBow past the reported length) to zero instead of wrapping', () => {
    // Without clamping, ggencoder packs a negative "dimB" as its two's
    // complement bit pattern -- a huge bogus positive dimension on the
    // wire, not an error. length=10, fromBow=15 => dimB would be -5.
    const nmea = encodeStaticClassA({
      mmsi: '211234567',
      aisClass: 'A',
      name: 'x',
      length: 10,
      beam: 4,
      fromBow: 15,
      fromCenter: 0
    })
    const decoded = new AisDecode(nmea as string)
    expect(decoded.valid).to.equal(true)
    expect(decoded.dimB).to.equal(0)
  })

  it('warns when clamping an out-of-range dimension, so the config inconsistency is not silently invisible', () => {
    const warnings: string[] = []
    encodeStaticClassA(
      {
        mmsi: '211234567',
        aisClass: 'A',
        name: 'x',
        length: 10,
        beam: 4,
        fromBow: 15, // > length -- dimB would go negative
        fromCenter: 0
      },
      (msg) => warnings.push(msg)
    )
    expect(warnings).to.have.length(1)
    expect(warnings[0]).to.match(/clamping/)
  })

  it('does not warn when dimensions are within range', () => {
    const warnings: string[] = []
    encodeStaticClassA(
      {
        mmsi: '211234567',
        aisClass: 'A',
        name: 'x',
        length: 12,
        beam: 4,
        fromBow: 6,
        fromCenter: 0
      },
      (msg) => warnings.push(msg)
    )
    expect(warnings).to.have.length(0)
  })
})

describe('sanitizeEndpoints', () => {
  it('keeps well-formed endpoints', () => {
    const warnings: string[] = []
    const result = sanitizeEndpoints(
      [{ ipaddress: 'listener.marinetraffic.com', port: 14577 }],
      (msg) => warnings.push(msg)
    )
    expect(result).to.deep.equal([
      { ipaddress: 'listener.marinetraffic.com', port: 14577 }
    ])
    expect(warnings).to.have.length(0)
  })

  it('drops endpoints with an invalid port and warns', () => {
    const warnings: string[] = []
    const result = sanitizeEndpoints(
      [{ ipaddress: '1.2.3.4', port: 70000 }],
      (msg) => warnings.push(msg)
    )
    expect(result).to.have.length(0)
    expect(warnings).to.have.length(1)
  })

  it('drops endpoints with an invalid port for every kind of bad value, not just out-of-range', () => {
    for (const badPort of [0, -1, 1.5, NaN, '14577', undefined, null]) {
      const warnings: string[] = []
      const result = sanitizeEndpoints(
        [{ ipaddress: '1.2.3.4', port: badPort }],
        (msg) => warnings.push(msg)
      )
      expect(result, `port ${JSON.stringify(badPort)}`).to.have.length(0)
      expect(warnings, `port ${JSON.stringify(badPort)}`).to.have.length(1)
    }
  })

  it('drops an endpoint with an invalid ipaddress and warns', () => {
    for (const badAddress of ['', 'has\r\ncrlf', 123, null, undefined]) {
      const warnings: string[] = []
      const result = sanitizeEndpoints(
        [{ ipaddress: badAddress, port: 14577 }],
        (msg) => warnings.push(msg)
      )
      expect(result, `ipaddress ${JSON.stringify(badAddress)}`).to.have.length(
        0
      )
      expect(
        warnings,
        `ipaddress ${JSON.stringify(badAddress)}`
      ).to.have.length(1)
    }
  })

  it('drops a non-object endpoint entry and warns', () => {
    const warnings: string[] = []
    const result = sanitizeEndpoints(['not-an-object', 5, null], (msg) =>
      warnings.push(msg)
    )
    expect(result).to.have.length(0)
    expect(warnings).to.have.length(3)
  })

  it('drops non-array input entirely', () => {
    expect(sanitizeEndpoints(undefined, () => undefined)).to.deep.equal([])
    expect(sanitizeEndpoints('nope', () => undefined)).to.deep.equal([])
  })
})

describe('sanitizeRateSeconds', () => {
  it('falls back to the default for NaN, negative, zero, or non-numeric input', () => {
    expect(sanitizeRateSeconds(NaN, 60)).to.equal(60)
    expect(sanitizeRateSeconds(-1, 60)).to.equal(60)
    expect(sanitizeRateSeconds(0, 60)).to.equal(60)
    expect(sanitizeRateSeconds('60', 60)).to.equal(60)
  })

  it('keeps a valid positive value', () => {
    expect(sanitizeRateSeconds(30, 60)).to.equal(30)
  })

  it('clamps a valid but sub-floor value up to the given minimum', () => {
    // Guards the two cadence knobs (poll/minForward interval) against a
    // fat-fingered sub-second value hammering the data model or flooding
    // the configured UDP endpoints.
    expect(sanitizeRateSeconds(0.01, 10, 1)).to.equal(1)
    expect(sanitizeRateSeconds(5, 10, 1)).to.equal(5)
  })

  it('has no floor by default, preserving the original unclamped behaviour', () => {
    expect(sanitizeRateSeconds(0.01, 10)).to.equal(0.01)
  })
})
