declare module 'ggencoder' {
  export interface AisEncodeOptions {
    mmsi: string
    aistype?: number
    repeat?: number
    part?: number
    navstatus?: number | undefined
    rot?: number | undefined
    sog?: number | undefined
    accuracy?: number
    lon?: number | undefined
    lat?: number | undefined
    cog?: number | undefined
    hdg?: number | undefined
    cargo?: number | undefined
    shipname?: string | undefined
    callsign?: string | undefined
    imo?: number | undefined
    dimA?: string | undefined
    dimB?: string | undefined
    dimC?: string | undefined
    dimD?: string | undefined
  }

  export class AisEncode {
    constructor(options: AisEncodeOptions)
    valid: boolean
    nmea: string
  }

  export class AisDecode {
    constructor(nmea: string)
    valid: boolean
    aistype: number
    part: number
    mmsi: string
    lat: number
    lon: number
    sog: number
    cog: number
    hdg: number
    navstatus: number
    rot: number
    shipname: string
    callsign: string
    cargo: number
    dimA: number
    dimB: number
    dimC: number
    dimD: number
  }
}
