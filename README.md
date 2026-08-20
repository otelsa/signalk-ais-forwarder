# signalk-ais-forwarder-noomi

Forwards AIS targets received by this Signal K server — other vessels'
positions, not this vessel's own — to UDP endpoints such as
[MarineTraffic](https://help.marinetraffic.com/hc/en-us/articles/205282657-Add-an-AIS-Receiving-Station-to-the-MarineTraffic-Network)
or [AISHub](https://www.aishub.net/), so this vessel can act as a
**roaming AIS station** in areas without a fixed terrestrial receiver.

Own-vessel position reporting is **not** handled by this plugin — that's
already covered well by
[`@signalk/aisreporter`](https://github.com/SignalK/aisreporter), which
keeps running unchanged alongside this plugin. This plugin only relays
what the vessel _receives_.

## Deployment

Developed on `noomi-lookout` (the boat's navigation Pi, where the node/npm/git
toolchain lives), but **runs on `noomi`** (the i5N100 host), not on
`noomi-lookout` — this plugin isn't navigation-essential, so it has no
business running on the box steering depends on. `noomi` runs Signal K in
Docker; deployment is `npm pack` on `noomi-lookout`, `scp` the tarball
into `~/noomi-data/signalk/`, then inside the `signalk` container:

```bash
npm install ./signalk-ais-forwarder-noomi-1.0.0.tgz   # extracts into node_modules/
mv node_modules/signalk-ais-forwarder-noomi ../signalk-ais-forwarder-noomi
# edit package.json: "signalk-ais-forwarder-noomi": "file:signalk-ais-forwarder-noomi"
npm install                                             # relinks node_modules/... -> ../signalk-ais-forwarder-noomi
```

The source must end up as a **sibling of `node_modules`**, not inside it.
A `file:` dependency whose target path is itself under `node_modules/`
(e.g. `file:node_modules/signalk-ais-forwarder-noomi`, the pattern
`signalk-distance-log-n2k` uses on this host) is fragile: npm's own
`node_modules/.package-lock.json` records a `resolved` tarball/path
snapshot from install time, and any later `npm install`/`npm remove`
elsewhere in the tree can try to reconcile against that stale snapshot,
deleting the one real copy of the plugin before "reinstalling" it from
itself -- ENOENT. This bit us once during an unrelated plugin removal on
`noomi` (see git history). The sibling-directory form npm resolves to a
proper `"link": true` entry, which survives arbitrary tree reconciliation
because npm only ever has to recreate a symlink, never the source
content. `aisreporter` (own position) still runs on `noomi-lookout`,
unaffected.

## Why a fork, and why this design

This plugin started as an evaluation of two existing projects:

- [hkapanen/ais-forwarder](https://github.com/hkapanen/ais-forwarder)
  (Apache-2.0) is exactly the right _concept_ — a small UDP relay for
  MarineTraffic/AISHub roaming stations — but it's a single-file
  JavaScript plugin, unmaintained since 2023, and works by listening for
  raw `!AIVDM`/`!AIVDO` NMEA0183 sentences on the server's event bus.
- [SignalK/aisreporter](https://github.com/SignalK/aisreporter)
  (Copyright 2016 Teppo Kurki, Apache-2.0) is actively maintained,
  written in TypeScript with tests, and — more importantly for this
  fork — encodes AIS sentences directly from the Signal K **data
  model** rather than from raw NMEA text.

On `noomi-lookout`, where this plugin was first evaluated (and on any
Signal K server whose AIS receiver is an NMEA2000 device rather than a
serial NMEA0183 unit), received AIS targets arrive as PGNs on the N2K bus
and are converted straight into the Signal K data model
(`vessels.<mmsi>.navigation.position`, etc.) — there is no `!AIVDM`
sentence anywhere unless a separate NMEA2000-to-0183 conversion plugin
(e.g. `signalk-n2kais-to-nmea0183`) is also installed and enabled.
`ais-forwarder`'s raw-NMEA-listening approach would simply never fire in
that setup. The data-model approach works there without needing that
converter plugin, and works identically on `noomi` (which has both an N2K
bus and a direct serial AIS receiver, plus `signalk-n2kais-to-nmea0183`
already enabled) regardless of which of those sources a given target
came from.

So this plugin is a fork of **aisreporter's architecture and AIS-encoding
code**, extended from "encode and send _my own_ position" to "encode and
send _every other vessel's_ position currently in the data model", using
`ais-forwarder`'s endpoint configuration shape (a list of `{ipaddress,
port}` targets) and its documented purpose (roaming station for
MarineTraffic/AISHub). Several helper functions in
[`src/encode.ts`](src/encode.ts) are adapted directly from aisreporter;
see the file header for attribution. Both upstream authors and
contributors are credited in `package.json`.

### Class A vs. Class B

Canboatjs tags each AIS position update from an N2K source with the
originating PGN: `129038` = AIS Class A Position Report, `129039` =
Class B. This plugin reads that tag (when present) to decide whether to
encode a target as AIS message type 1 (Class A, with navigational status
and rate of turn) or type 18 (Class B). Targets from a source that
doesn't carry this PGN tag (e.g. a raw NMEA0183 AIS receiver) default to
Class B, which keeps the encoded sentence valid without having to guess
a navigational status.

## Configuration

Configured in the Signal K admin UI under **Server → Plugin Config →
AIS Forwarder (Noomi)**:

| Setting                          | Default                            | Meaning                                                                                                                                        |
| -------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints                        | `listener.marinetraffic.com:14577` | One or more UDP targets. Add AISHub's UDP endpoint here too if you have an AISHub account — the same station can feed both from the same list. |
| Poll interval                    | 10s                                | How often the Signal K data model is scanned for AIS targets.                                                                                  |
| Min. forward interval per target | 10s                                | Floor on how often any single target's position is re-sent, so a very active target can't flood the endpoints.                                 |
| Static update interval           | 360s                               | How often each active target's static/voyage data (name, callsign, dimensions, ship type) is (re)sent.                                         |
| Target staleness                 | 15min                              | A target whose position hasn't updated within this window stops being forwarded and drops out of the status view.                              |

MarineTraffic assigns the UDP host/port for a given station registration
per-account — `listener.marinetraffic.com:14577` above is prefilled to
match what this vessel's `aisreporter` install already uses for its own
position, since MarineTraffic accepts both own-position (AIVDO-derived)
and other-vessel (AIVDM-derived) traffic on the same station feed.

## Status webapp

Since UDP has no delivery acknowledgement, "status" here means _"what
this plugin has observed and sent locally"_, not _"what MarineTraffic
received"_. The webapp (Signal K → Webapps → AIS Forwarder) shows:

- how many AIS targets are currently being tracked and relayed;
- messages/minute and total messages sent, per configured endpoint;
- OS-level send errors, if any (rare for UDP to a routable host, but
  `dgram.send`'s callback does surface things like an unreachable
  route);
- the currently tracked targets (MMSI, name, class, last seen/forwarded);
- a rolling log of the last ~25 sentences actually sent.

The most useful signal that the whole pipeline is working end-to-end is
simply **"targets tracked" being non-zero and climbing** — that means
this server is receiving real AIS traffic and re-encoding it. Whether
MarineTraffic's backend accepted it can only be confirmed on
MarineTraffic's own station dashboard.

The same headline numbers are also published into the Signal K data
model under `aisForwarder.status.*`, so other dashboards (e.g.
Instrument Panel) can surface them too.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # mocha, via tsx, against src/
npm run typecheck
npm run prettier:check
```

Tests cover the pure AIS-encoding helpers in `src/encode.ts` (including
round-tripping generated sentences through `ggencoder`'s decoder) and an
end-to-end path in `test/plugin.test.ts` that runs the plugin against a
stub Signal K app and a real UDP socket.

## License

Apache-2.0, matching both upstream projects. See `LICENSE` and the
attribution notes in `src/encode.ts`.
