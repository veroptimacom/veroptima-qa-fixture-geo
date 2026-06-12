# veroptima-qa-fixture-geo

Geospatial fixture pack for [qa-expert](https://github.com/ricardo-hdrn) plugins. Implements `@qa-expert/fixture-pack-contract` **v0.1.0** (see ADR-0014 + the fixture-pack-enrichment spec).

A single domain pack exposing four kinds that describe **the same parametric polygon** in four surface formats — agents pick the form a given input field demands.

## Kinds

| Kind | outputs | locales | params |
|---|---|---|---|
| `kml` | `string` | locale-agnostic | `{ maxHa: number, region: "clean" \| "overlap" }` |
| `wkt` | `string` | locale-agnostic | `{ maxHa: number, region: "clean" \| "overlap" }` |
| `geojson` | `string` | locale-agnostic | `{ maxHa: number, region: "clean" \| "overlap" }` |
| `shapefile-zip` | `file` (`application/zip`, `shapefile.zip`) | locale-agnostic | `{ maxHa: number, region: "clean" \| "overlap" }` |

### Params

- `maxHa` (default `100`) — upper bound on the parcel's area, in hectares. Actual area is a seeded fraction (50%–95%) of this bound so the agent has a single knob: *"no bigger than X."*
- `region` (default `"clean"`) — branch-targeting axis (ADR-0014 §branch-targeting):
  - `"clean"` → polygon placed **5° east** of the seeded quilombo reference, never intersecting its bbox. Targets the auto-issuance branch in a SICAR-style territorial-certificate flow.
  - `"overlap"` → polygon centered at the quilombo reference with a small seeded jitter; its bbox is **guaranteed to intersect** the reference. Targets the manual-analysis branch.

## Reference quilombo polygon (audit-visible)

Baked into [`src/index.ts`](./src/index.ts):

```
centerLng = -48.0   centerLat = -22.0   halfDeg = 0.0135   (~1.5 km half-side)
```

This is interior São Paulo state — the location itself is irrelevant; only its presence as a **shared, known obstacle** the `overlap` branch must hit. A test asserts every `overlap` polygon, across many seeds, has a bbox that intersects this reference, and every `clean` polygon does not.

## Determinism (LOAD-BEARING)

Same `(seed, params, locale)` → byte-identical output, every kind, every call:

- PRNG is a hand-rolled **sfc32** seeded from **FNV-1a** of `ctx.seed` (no `Math.random()`, no `Date.now()`, no UUIDs).
- Polygon centers/areas are derived from that PRNG.
- Coordinates are formatted with 8 fixed decimals (≈ 1.1 mm precision) so string forms are byte-stable.
- The shapefile zip uses **epoch-zero (`new Date(0)`) per-entry timestamps** and `createFolders: false`; the `.dbf` last-update date is hard-coded to `1900-01-01` and STORE compression is used (no deflate-level dependency). The `.shp` header's bbox fields are derived **from the polygon**, not from a clock or any randomness.

A cross-call replay test asserts byte equality for every kind.

## Wrap-vs-author policy (spec A4)

Per the fixture-pack-enrichment spec, this pack **wraps `jszip`** for the `shapefile-zip` kind and **authors from scratch** for everything else.

**Wrap (`jszip` for the zip container)**: rule-of-thumb says wrap "file container plumbing" — the format is a solved commodity and a wrongness is loud (a malformed zip fails to extract; the test catches it). Reimplementing a zip writer for a fixture pack is waste with no moat.

**Author from scratch (everything else)**:

- **Coordinate math + region targeting**: the *targeting* is the moat. A library that places a generic random polygon will silently land on the wrong code branch; we want a `clean` polygon to be **provably** outside the quilombo bbox and an `overlap` polygon to be **provably** inside it. Hand-coded.
- **Polygon → KML / WKT / GeoJSON serialization**: tiny well-defined surfaces; the libraries are heavier than the code they replace, and wrapping one would add another integrity-lock surface (spec A4 guard #1) for no gain.
- **Shapefile binary (`.shp` / `.shx` / `.dbf` / `.prj`)**: the byte layout is determinism-critical. Some existing libraries inject the current date into the `.dbf` header or randomise field-descriptor padding; rather than monkey-patching their clock, we write the layout directly per the 1998 ESRI whitepaper. Comments in `src/index.ts` flag the big-endian-vs-little-endian footgun explicitly.

`jszip` is driven with `date: new Date(0)` and `createFolders: false` on every `.file()` call — both required to make its bytes reproducible (spec A4 guard #2: "force the seed through" — for `jszip` the analogous knob is "force the timestamp out").

## Tests

```bash
bun install
bun x tsc --noEmit
bun test
```

The suite covers:

- factory shape (manifest declares the four kinds with correct outputs);
- per-kind cross-call replay (byte-identical string for `kml`/`wkt`/`geojson`, byte-identical zip for `shapefile-zip`);
- KML, WKT, and GeoJSON describe the **same** polygon for the same `(seed, params)` (round-trips each via a tiny in-test parser);
- `region: "overlap"` always intersects the quilombo reference bbox; `region: "clean"` never does (asserted across many seeds);
- `shapefile-zip` extracts cleanly, the `.shp` magic header is `0x00 0x00 0x27 0x0A`, and `.prj` is recognisable WGS84 WKT.

## License

MIT — see [`LICENSE`](./LICENSE). Copyright 2026 Ricardo Gusmão.
