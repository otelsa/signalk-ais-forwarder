export interface EndpointConfig {
  ipaddress: string
  port: number
}

export interface EndpointStats extends EndpointConfig {
  messagesSent: number
  bytesSent: number
  lastSendAt?: number
  lastError?: string
  lastErrorAt?: number
}

export interface TargetInfo {
  mmsi: string
  name?: string
  aisClass: 'A' | 'B'
  lastSeenAt: number
  lastForwardAt?: number
}

export interface RecentMessage {
  at: number
  nmea: string
}

const RECENT_MESSAGES_LIMIT = 25
// Long enough to smooth a burst, short enough that "messages/min" reacts
// within a minute of endpoints actually going quiet.
const RATE_WINDOW_MS = 60_000
// Unlike every other structure in this class, seenMmsiEver is deliberately
// never pruned by activity (it's a lifetime distinct-vessel counter, and a
// vessel that goes stale and later reappears must NOT be double-counted).
// That correctness requirement means it can't be swapped for a plain
// incrementing counter -- it genuinely needs to remember every mmsi ever
// seen. This cap is a pure safety backstop against unbounded growth on an
// unattended multi-year run, set far above any realistic count (worldwide
// MMSI allocations only number in the low hundreds of thousands) so it is
// not expected to ever actually bind in practice; if it does, the oldest
// entries are evicted and could in principle be double-counted on
// reappearance, but by then the metric was already an approximation.
const SEEN_MMSI_CAP = 100_000

export interface StatusSnapshot {
  startedAt: number
  uptimeSeconds: number
  enabled: boolean
  lastError: string | null
  lastErrorAt: number | null
  targetsTracked: number
  targetsSeenTotal: number
  messagesSentTotal: number
  messagesSentLastMinute: number
  lastForwardAgeSeconds: number | null
  endpoints: EndpointStats[]
  targets: TargetInfo[]
  recentMessages: RecentMessage[]
}

// Tracks everything the plugin can observe locally about its own
// operation. UDP has no delivery acknowledgement, so this is
// deliberately framed as "what we sent and to whom", not "what arrived" --
// see README for that distinction.
export class Stats {
  readonly startedAt = Date.now()
  private totalMessagesSent = 0
  private sendTimestamps: number[] = []
  private lastForwardAt: number | undefined
  private lastError: string | undefined
  private lastErrorAt: number | undefined
  private readonly endpoints = new Map<string, EndpointStats>()
  private readonly targets = new Map<string, TargetInfo>()
  private readonly recentMessages: RecentMessage[] = []
  // Not pruned -- a running count of distinct vessels seen since start,
  // independent of `targets` which only holds currently-active ones.
  private readonly seenMmsiEver = new Set<string>()

  endpointKey(ep: EndpointConfig): string {
    return `${ep.ipaddress}:${ep.port}`
  }

  ensureEndpoint(ep: EndpointConfig): EndpointStats {
    const key = this.endpointKey(ep)
    let existing = this.endpoints.get(key)
    if (!existing) {
      existing = { ...ep, messagesSent: 0, bytesSent: 0 }
      this.endpoints.set(key, existing)
    }
    return existing
  }

  // Endpoints removed from config should stop showing up in status.
  syncEndpoints(configured: EndpointConfig[]): void {
    const keys = new Set(configured.map((ep) => this.endpointKey(ep)))
    for (const key of Array.from(this.endpoints.keys())) {
      if (!keys.has(key)) this.endpoints.delete(key)
    }
    configured.forEach((ep) => this.ensureEndpoint(ep))
  }

  noteSend(ep: EndpointConfig, bytes: number): void {
    const stats = this.ensureEndpoint(ep)
    stats.messagesSent++
    stats.bytesSent += bytes
    stats.lastSendAt = Date.now()
  }

  noteSendError(ep: EndpointConfig, message: string): void {
    const stats = this.ensureEndpoint(ep)
    stats.lastError = message
    stats.lastErrorAt = Date.now()
    this.lastError = message
    this.lastErrorAt = Date.now()
  }

  // For faults that aren't tied to any one endpoint (a socket-level error --
  // EMFILE, a bind failure -- rather than an individual send() failing).
  // Surfaces the same way an endpoint send error does (lastError/lastErrorAt
  // in the snapshot, and therefore in both /status and setPluginStatus()),
  // so a socket fault doesn't look like a silently-still-healthy plugin.
  noteSocketError(message: string): void {
    this.lastError = message
    this.lastErrorAt = Date.now()
  }

  noteMessageBroadcast(nmea: string): void {
    const now = Date.now()
    this.totalMessagesSent++
    this.lastForwardAt = now
    this.sendTimestamps.push(now)
    const cutoff = now - RATE_WINDOW_MS
    while (
      this.sendTimestamps.length > 0 &&
      (this.sendTimestamps[0] as number) < cutoff
    ) {
      this.sendTimestamps.shift()
    }
    this.recentMessages.push({ at: now, nmea })
    if (this.recentMessages.length > RECENT_MESSAGES_LIMIT) {
      this.recentMessages.shift()
    }
  }

  noteTargetSeen(
    mmsi: string,
    name: string | undefined,
    aisClass: 'A' | 'B'
  ): void {
    const now = Date.now()
    if (
      !this.seenMmsiEver.has(mmsi) &&
      this.seenMmsiEver.size >= SEEN_MMSI_CAP
    ) {
      // Set iteration order is insertion order (ECMA-262), so this is
      // reliably the oldest still-tracked entry. The size check above
      // guarantees at least one entry exists, so .value is always a string
      // here, never undefined -- no need to guard it again.
      this.seenMmsiEver.delete(this.seenMmsiEver.values().next().value as string)
    }
    this.seenMmsiEver.add(mmsi)
    const existing = this.targets.get(mmsi)
    if (existing) {
      existing.lastSeenAt = now
      existing.aisClass = aisClass
      if (name) existing.name = name
    } else {
      this.targets.set(mmsi, { mmsi, name, aisClass, lastSeenAt: now })
    }
  }

  noteTargetForwarded(mmsi: string): void {
    const target = this.targets.get(mmsi)
    if (target) target.lastForwardAt = Date.now()
  }

  // Drop targets that fell out of the currently-active set (stale
  // position, vessel disappeared from the Signal K data model) so the
  // status view doesn't accumulate ghost entries forever.
  pruneTargets(activeMmsi: ReadonlySet<string>): void {
    for (const mmsi of Array.from(this.targets.keys())) {
      if (!activeMmsi.has(mmsi)) this.targets.delete(mmsi)
    }
  }

  snapshot(enabled: boolean): StatusSnapshot {
    const now = Date.now()
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((now - this.startedAt) / 1000),
      enabled,
      lastError: this.lastError ?? null,
      lastErrorAt: this.lastErrorAt ?? null,
      targetsTracked: this.targets.size,
      targetsSeenTotal: this.seenMmsiEver.size,
      messagesSentTotal: this.totalMessagesSent,
      messagesSentLastMinute: this.sendTimestamps.length,
      lastForwardAgeSeconds: this.lastForwardAt
        ? Math.round((now - this.lastForwardAt) / 1000)
        : null,
      endpoints: Array.from(this.endpoints.values()),
      targets: Array.from(this.targets.values()).sort(
        (a, b) => b.lastSeenAt - a.lastSeenAt
      ),
      recentMessages: [...this.recentMessages].reverse()
    }
  }
}
