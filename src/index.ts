/**
 * veroptima-qa-fixture-geo — geospatial fixture pack for qa-expert.
 *
 * Implements `@qa-expert/fixture-pack-contract` v0.1.0. A single domain pack
 * exposing four kinds that describe the SAME parametric polygon in four
 * surface formats — agents can pick the form a given input field demands:
 *
 *   - `kml`            → KML XML (string)
 *   - `wkt`            → WKT POLYGON((...)) (string)
 *   - `geojson`        → GeoJSON Feature (string, JSON-serialized)
 *   - `shapefile-zip`  → zipped shapefile bundle (.shp/.shx/.dbf/.prj) (file)
 *
 * The pack's moat is `params.region`: `"clean"` places the polygon far from a
 * baked seeded "quilombo" reference polygon; `"overlap"` places it so its
 * bounding box intersects the reference. These two values target the two
 * code paths in a typical SICAR-style territorial-certificate flow
 * (auto-issuance vs manual analysis), per ADR-0014 §branch-targeting.
 *
 * Determinism is LOAD-BEARING:
 *   - same (seed, params.region, params.maxHa, params.locale?) → byte-
 *     identical output, every kind, every call;
 *   - the PRNG is a hand-implemented sfc32 seeded from FNV-1a of `ctx.seed`;
 *   - no `Math.random()`, no `Date.now()`, no UUIDs;
 *   - the shapefile zip uses epoch-zero timestamps on every entry so the
 *     resulting bytes are reproducible.
 */
import {
  defineFixturePack,
  type FileFixture,
  type FixturePackManifest,
  type GenContext,
  type Generator,
} from "@qa-expert/fixture-pack-contract";
import JSZip from "jszip";
import { z } from "zod";
import manifestJson from "../fixture-pack.json" with { type: "json" };

// The JSON import widens `family` to `string`; the contract requires the
// literal `"fixture-pack"`. `defineFixturePack` re-validates at runtime
// via FixturePackManifestSchema, so the cast is type-only.
const manifest = manifestJson as unknown as FixturePackManifest;

// ─────────────────────────────────────────────────────────────────────────────
// Params + seeded PRNG
// ─────────────────────────────────────────────────────────────────────────────

const RegionEnum = z.enum(["clean", "overlap"]);

/** Common params for every geo kind. */
export const GeoParamsSchema = z
  .object({
    /**
     * Upper bound on the generated parcel's area, in hectares. The
     * actual area is a deterministic fraction of this bound (so the
     * agent has a single knob: "no bigger than X").
     */
    maxHa: z.number().positive().max(1_000_000).default(100),
    /**
     * Branch-targeting axis.
     *   - `"clean"`   → polygon located far from the seeded quilombo reference
     *                   (auto-issuance branch in the canonical flow).
     *   - `"overlap"` → polygon positioned so its bounding box intersects the
     *                   seeded quilombo reference (manual-analysis branch).
     */
    region: RegionEnum.default("clean"),
  })
  .strict();
export type GeoParams = z.infer<typeof GeoParamsSchema>;

/**
 * FNV-1a 32-bit hash. Used to fold the string `seed` into a uint32 the
 * sfc32 PRNG can ingest. Same input → same output, always.
 */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193); // FNV prime; Math.imul keeps 32-bit
  }
  return h >>> 0;
}

/**
 * sfc32 PRNG. 128-bit state, deterministic, fast, decent statistical
 * quality. Hand-rolled per spec (no `Math.random()`).
 */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Build a deterministic PRNG from `ctx.seed` and the kind name. Mixing in
 * the kind name lets every kind share the SAME polygon for a given (seed,
 * params) while letting per-kind nonces stay separate where needed.
 */
function makeRng(ctx: GenContext, salt: string): () => number {
  const s = fnv1a32(ctx.seed + "::" + salt);
  // Splash the single uint32 across four sfc32 lanes via a Weyl-style step.
  const a = s;
  const b = (s ^ 0x9e3779b9) >>> 0;
  const c = (s + 0x85ebca6b) >>> 0;
  const d = (s ^ 0xc2b2ae35) >>> 0;
  return sfc32(a, b, c, d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seeded "quilombo" reference polygon. Baked into the source so it is
 * audit-visible and replay-stable across hosts. Coordinates are WGS84
 * (lng, lat). It is a small ~3km square centered in interior São Paulo
 * state; the exact location is irrelevant — only its presence as a
 * SHARED, KNOWN obstacle the `overlap` branch must hit.
 *
 * Ring is closed (first point repeated at the end) per OGC simple-feature
 * rules, listed CCW for the exterior.
 */
export const QUILOMBO_REFERENCE = {
  centerLng: -48.0,
  centerLat: -22.0,
  /** Half-side in degrees, ≈ 1.5 km on each side at this latitude. */
  halfDeg: 0.0135,
} as const;

const QUILOMBO_BBOX = {
  minLng: QUILOMBO_REFERENCE.centerLng - QUILOMBO_REFERENCE.halfDeg,
  maxLng: QUILOMBO_REFERENCE.centerLng + QUILOMBO_REFERENCE.halfDeg,
  minLat: QUILOMBO_REFERENCE.centerLat - QUILOMBO_REFERENCE.halfDeg,
  maxLat: QUILOMBO_REFERENCE.centerLat + QUILOMBO_REFERENCE.halfDeg,
};

const METERS_PER_DEG_LAT = 111_320;

/** A closed-ring polygon in (lng, lat). First point repeated at the end. */
export interface Polygon {
  /** Ring of [lng, lat] pairs. ring[0] === ring[ring.length-1]. */
  ring: ReadonlyArray<readonly [number, number]>;
  /** Center lng/lat used to construct it (kept for readability). */
  centerLng: number;
  centerLat: number;
  /** Approximate area in hectares (for descriptive output). */
  areaHa: number;
  /** Axis-aligned bounding box. */
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
}

/**
 * Derive the polygon for a (seed, params) pair. Same inputs → same polygon.
 *
 * - `clean`:   anchored 5° east of the quilombo reference (far away) with
 *              a small seeded jitter; never intersects the bbox.
 * - `overlap`: anchored at the quilombo center with a small seeded jitter
 *              well inside the half-side bound; bbox is guaranteed to
 *              intersect the reference.
 *
 * Area is a seeded fraction (50%–95%) of `maxHa` so two seeds rarely
 * collide on area but every parcel respects the cap.
 */
export function derivePolygon(params: GeoParams, ctx: GenContext): Polygon {
  // Use a single shared salt so kml/wkt/geojson/shapefile-zip see the
  // SAME polygon for a given (seed, params).
  const rng = makeRng(ctx, "polygon");
  const areaHa = params.maxHa * (0.5 + rng() * 0.45); // 50%–95% of maxHa
  const sideM = Math.sqrt(areaHa * 10_000); // ha → m², square side in metres

  let centerLng: number;
  let centerLat: number;
  if (params.region === "overlap") {
    // Jitter inside ~30% of the half-side, so bbox intersection is
    // guaranteed regardless of seed.
    const jitter = QUILOMBO_REFERENCE.halfDeg * 0.3;
    centerLng = QUILOMBO_REFERENCE.centerLng + (rng() * 2 - 1) * jitter;
    centerLat = QUILOMBO_REFERENCE.centerLat + (rng() * 2 - 1) * jitter;
  } else {
    // 5° east of the reference (far away — 5° at this latitude ≈ 500 km),
    // with a tiny ±0.1° jitter that cannot push it into the bbox.
    centerLng = QUILOMBO_REFERENCE.centerLng + 5.0 + (rng() * 2 - 1) * 0.1;
    centerLat = QUILOMBO_REFERENCE.centerLat + (rng() * 2 - 1) * 0.1;
  }

  const halfM = sideM / 2;
  const dLat = halfM / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const dLng = halfM / (METERS_PER_DEG_LAT * cosLat);

  // CCW exterior ring: SW → SE → NE → NW → SW.
  const sw: [number, number] = [centerLng - dLng, centerLat - dLat];
  const se: [number, number] = [centerLng + dLng, centerLat - dLat];
  const ne: [number, number] = [centerLng + dLng, centerLat + dLat];
  const nw: [number, number] = [centerLng - dLng, centerLat + dLat];
  const ring: ReadonlyArray<readonly [number, number]> = [sw, se, ne, nw, sw];

  return {
    ring,
    centerLng,
    centerLat,
    areaHa,
    bbox: {
      minLng: centerLng - dLng,
      maxLng: centerLng + dLng,
      minLat: centerLat - dLat,
      maxLat: centerLat + dLat,
    },
  };
}

/** True iff two bboxes share at least one point. */
export function bboxesIntersect(
  a: Polygon["bbox"],
  b: typeof QUILOMBO_BBOX,
): boolean {
  return (
    a.minLng <= b.maxLng &&
    a.maxLng >= b.minLng &&
    a.minLat <= b.maxLat &&
    a.maxLat >= b.minLat
  );
}

/** Quilombo reference bbox, exported for tests. */
export function quilomboBbox(): typeof QUILOMBO_BBOX {
  return QUILOMBO_BBOX;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate formatting — fixed decimals so output is byte-stable.
// ─────────────────────────────────────────────────────────────────────────────

/** 8 decimals ≈ 1.1 mm precision; matches the existing qa-fixture-kml pack. */
function fmt(n: number): string {
  return n.toFixed(8);
}

// ─────────────────────────────────────────────────────────────────────────────
// KML
// ─────────────────────────────────────────────────────────────────────────────

function renderKml(poly: Polygon, params: GeoParams): string {
  const coords = poly.ring
    .map(([x, y]) => `${fmt(x)},${fmt(y)},0`)
    .join(" ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <Placemark>`,
    `      <name>Parcela QA (${params.region})</name>`,
    `      <description>~${poly.areaHa.toFixed(2)} ha @ ${fmt(poly.centerLng)},${fmt(poly.centerLat)}</description>`,
    "      <Polygon>",
    "        <outerBoundaryIs>",
    "          <LinearRing>",
    `            <coordinates>${coords}</coordinates>`,
    "          </LinearRing>",
    "        </outerBoundaryIs>",
    "      </Polygon>",
    "    </Placemark>",
    "  </Document>",
    "</kml>",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// WKT
// ─────────────────────────────────────────────────────────────────────────────

function renderWkt(poly: Polygon): string {
  const coords = poly.ring.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(", ");
  return `POLYGON((${coords}))`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GeoJSON
// ─────────────────────────────────────────────────────────────────────────────

function renderGeoJson(poly: Polygon, params: GeoParams): string {
  // GeoJSON wants raw numbers, but we round to 8 decimals so the JSON
  // string is byte-stable across hosts. JSON.stringify of `Number(x.toFixed(8))`
  // is the cleanest way to get that.
  const coords = poly.ring.map(([x, y]) => [
    Number(fmt(x)),
    Number(fmt(y)),
  ]);
  const feature = {
    type: "Feature",
    properties: {
      name: `Parcela QA (${params.region})`,
      areaHa: Number(poly.areaHa.toFixed(2)),
      region: params.region,
    },
    geometry: {
      type: "Polygon",
      coordinates: [coords],
    },
  };
  return JSON.stringify(feature);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapefile (.shp / .shx / .dbf / .prj) — byte-deterministic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ESRI Shapefile, "Polygon" shape type (code 5). Byte layout is defined in
 * the ESRI whitepaper (1998). We emit a single polygon with one part.
 *
 * Note on endianness (a footgun the whitepaper makes legitimately tricky):
 *   - File header up through the bbox section is BIG-endian for the first
 *     7 fields (file code, unused×5, file length), then LITTLE-endian for
 *     version, shape type, and bbox doubles.
 *   - Record header (record number + content length) is BIG-endian.
 *   - Record content (shape type + bbox + numParts + numPoints + parts +
 *     points) is LITTLE-endian throughout.
 *
 * No timestamp/random fields exist in the .shp/.shx layout itself; the
 * only non-determinism risk is the .dbf header date (3 bytes YY/MM/DD).
 * We hard-code 1900-01-01 (00/01/01) so the bytes never depend on a clock.
 */

const SHP_FILE_CODE = 9994; // "0x0000270A" big-endian per spec
const SHP_VERSION = 1000;
const SHP_TYPE_POLYGON = 5;

function buildShp(poly: Polygon): { shp: Uint8Array; shx: Uint8Array } {
  // Geometry expressed as XY doubles in record-content order.
  const pts = poly.ring; // already closed
  const numPoints = pts.length;
  const numParts = 1;

  // Bbox over the ring (= polygon bbox; min/max).
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const [x, y] of pts) {
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  // ── Record content (little-endian) ───
  // shape type (int32) + bbox (4 doubles) + numParts (int32) + numPoints (int32)
  // + parts[numParts] (int32) + points[numPoints] (2 doubles each)
  const recordContentLengthBytes =
    4 + // shape type
    4 * 8 + // bbox
    4 + 4 + // numParts, numPoints
    numParts * 4 + // parts
    numPoints * 2 * 8; // points

  // ── Record header (big-endian) ───
  // record number (int32) + content length in 16-bit words (int32)
  const recordHeaderBytes = 8;

  // ── File header is always 100 bytes ───
  const FILE_HEADER_BYTES = 100;

  const shpTotalBytes =
    FILE_HEADER_BYTES + recordHeaderBytes + recordContentLengthBytes;

  // Build SHP
  const shp = new Uint8Array(shpTotalBytes);
  const shpView = new DataView(shp.buffer);
  writeShpFileHeader(shpView, shpTotalBytes, {
    xMin,
    yMin,
    xMax,
    yMax,
    shapeType: SHP_TYPE_POLYGON,
  });

  // Record header @ offset 100
  const recordNumber = 1;
  const recordContentLengthWords = recordContentLengthBytes / 2;
  shpView.setInt32(100, recordNumber, false); // big-endian
  shpView.setInt32(104, recordContentLengthWords, false); // big-endian

  // Record content @ offset 108
  let off = 108;
  shpView.setInt32(off, SHP_TYPE_POLYGON, true); off += 4;
  shpView.setFloat64(off, xMin, true); off += 8;
  shpView.setFloat64(off, yMin, true); off += 8;
  shpView.setFloat64(off, xMax, true); off += 8;
  shpView.setFloat64(off, yMax, true); off += 8;
  shpView.setInt32(off, numParts, true); off += 4;
  shpView.setInt32(off, numPoints, true); off += 4;
  // parts[0] = 0 (single ring starts at point 0)
  shpView.setInt32(off, 0, true); off += 4;
  for (const [x, y] of pts) {
    shpView.setFloat64(off, x, true); off += 8;
    shpView.setFloat64(off, y, true); off += 8;
  }

  // ── SHX (index) ───
  // 100-byte file header (same as .shp but file length covers only 50w + 4w),
  // then one 8-byte index record (offset in 16-bit words, content length in words).
  const SHX_HEADER_BYTES = 100;
  const SHX_INDEX_RECORD_BYTES = 8;
  const shxTotalBytes = SHX_HEADER_BYTES + SHX_INDEX_RECORD_BYTES;
  const shx = new Uint8Array(shxTotalBytes);
  const shxView = new DataView(shx.buffer);
  writeShpFileHeader(shxView, shxTotalBytes, {
    xMin,
    yMin,
    xMax,
    yMax,
    shapeType: SHP_TYPE_POLYGON,
  });
  // index record: offset (in words) = (100 bytes) / 2 = 50; length in words = recordContentLengthWords
  shxView.setInt32(100, 50, false); // big-endian
  shxView.setInt32(104, recordContentLengthWords, false); // big-endian

  return { shp, shx };
}

function writeShpFileHeader(
  view: DataView,
  totalBytes: number,
  bbox: { xMin: number; yMin: number; xMax: number; yMax: number; shapeType: number },
): void {
  // File code (big-endian)
  view.setInt32(0, SHP_FILE_CODE, false);
  // unused×5 (already zero)
  // File length in 16-bit words (big-endian)
  view.setInt32(24, totalBytes / 2, false);
  // Version (little-endian)
  view.setInt32(28, SHP_VERSION, true);
  // Shape type (little-endian)
  view.setInt32(32, bbox.shapeType, true);
  // Bbox: xmin, ymin, xmax, ymax (little-endian)
  view.setFloat64(36, bbox.xMin, true);
  view.setFloat64(44, bbox.yMin, true);
  view.setFloat64(52, bbox.xMax, true);
  view.setFloat64(60, bbox.yMax, true);
  // Zmin/Zmax/Mmin/Mmax = 0 (already zero) at offsets 68/76/84/92
}

/**
 * dBASE III / IV style .dbf with one row, one field, fixed date 1900-01-01
 * so the bytes never depend on a clock.
 */
function buildDbf(): Uint8Array {
  // Header layout:
  //   byte 0       = version (0x03 = dBASE III without memo)
  //   bytes 1-3    = last update YY/MM/DD
  //   bytes 4-7    = number of records (little-endian int32)
  //   bytes 8-9    = header length in bytes (little-endian int16)
  //   bytes 10-11  = record length in bytes (little-endian int16)
  //   bytes 12-31  = reserved (zero)
  //   then 32-byte field descriptors, terminated by 0x0D.
  // We define one field: NAME (Character, length 16).
  const fieldName = "NAME"; // up to 10 chars + 1 zero terminator
  const fieldNameAscii = new TextEncoder().encode(fieldName);
  const fieldType = "C".charCodeAt(0);
  const fieldLength = 16;

  const HEADER_BYTES = 32 + 32 + 1; // file header + 1 field descriptor + 0x0D terminator
  const RECORD_BYTES = 1 /* deletion flag */ + fieldLength;
  const NUM_RECORDS = 1;
  const TOTAL_BYTES = HEADER_BYTES + NUM_RECORDS * RECORD_BYTES + 1; // + 0x1A EOF

  const dbf = new Uint8Array(TOTAL_BYTES);
  const view = new DataView(dbf.buffer);

  // File header
  dbf[0] = 0x03;
  // Last update date: 1900-01-01 → YY=0, MM=1, DD=1
  dbf[1] = 0;
  dbf[2] = 1;
  dbf[3] = 1;
  view.setInt32(4, NUM_RECORDS, true);
  view.setInt16(8, HEADER_BYTES, true);
  view.setInt16(10, RECORD_BYTES, true);
  // 12-31 reserved (already zero)

  // Field descriptor @ offset 32
  for (let i = 0; i < fieldNameAscii.length && i < 11; i++) {
    dbf[32 + i] = fieldNameAscii[i]!;
  }
  // bytes 32+11..32+10 are zero (name zero-terminated)
  dbf[32 + 11] = fieldType; // field type
  // 32+12..32+15 reserved (zero)
  dbf[32 + 16] = fieldLength; // field length
  dbf[32 + 17] = 0; // decimal count
  // rest of descriptor zero

  // Header terminator
  dbf[64] = 0x0d;

  // Record @ offset 65: deletion flag (space = active) + NAME padded
  dbf[65] = 0x20;
  const value = new TextEncoder().encode("PARCELA_QA");
  for (let i = 0; i < fieldLength; i++) {
    dbf[66 + i] = i < value.length ? value[i]! : 0x20;
  }

  // EOF marker
  dbf[TOTAL_BYTES - 1] = 0x1a;

  return dbf;
}

/** Minimal WGS84 lat/lng .prj content (WKT-CRS form). */
function buildPrj(): Uint8Array {
  const wkt =
    'GEOGCS["WGS 84",' +
    'DATUM["WGS_1984",' +
    'SPHEROID["WGS 84",6378137,298.257223563]],' +
    'PRIMEM["Greenwich",0],' +
    'UNIT["degree",0.0174532925199433]]';
  return new TextEncoder().encode(wkt);
}

/**
 * Build the four shapefile members AND zip them with epoch-zero per-entry
 * timestamps so the resulting zip bytes are reproducible across hosts /
 * across processes.
 */
async function buildShapefileZip(poly: Polygon): Promise<Uint8Array> {
  const { shp, shx } = buildShp(poly);
  const dbf = buildDbf();
  const prj = buildPrj();

  const zip = new JSZip();
  const epoch = new Date(0); // 1970-01-01T00:00:00Z — DOS date 1980-01-01 floor
  const fixedOpts = { date: epoch, createFolders: false } as const;
  zip.file("parcela.shp", shp, fixedOpts);
  zip.file("parcela.shx", shx, fixedOpts);
  zip.file("parcela.dbf", dbf, fixedOpts);
  zip.file("parcela.prj", prj, fixedOpts);

  // STORE rather than DEFLATE to keep the bytes auditable and avoid
  // depending on zlib's deflate-level stability across hosts.
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "STORE",
    streamFiles: false,
  });
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

const kmlGenerator: Generator<GeoParams, string> = {
  kind: "kml",
  outputs: "string",
  paramsSchema: GeoParamsSchema,
  generate(params, ctx) {
    const p = GeoParamsSchema.parse(params);
    const poly = derivePolygon(p, ctx);
    return renderKml(poly, p);
  },
};

const wktGenerator: Generator<GeoParams, string> = {
  kind: "wkt",
  outputs: "string",
  paramsSchema: GeoParamsSchema,
  generate(params, ctx) {
    const p = GeoParamsSchema.parse(params);
    const poly = derivePolygon(p, ctx);
    return renderWkt(poly);
  },
};

const geoJsonGenerator: Generator<GeoParams, string> = {
  kind: "geojson",
  outputs: "string",
  paramsSchema: GeoParamsSchema,
  generate(params, ctx) {
    const p = GeoParamsSchema.parse(params);
    const poly = derivePolygon(p, ctx);
    return renderGeoJson(poly, p);
  },
};

const shapefileZipGenerator: Generator<GeoParams, FileFixture> = {
  kind: "shapefile-zip",
  outputs: "file",
  paramsSchema: GeoParamsSchema,
  async generate(params, ctx) {
    const p = GeoParamsSchema.parse(params);
    const poly = derivePolygon(p, ctx);
    const bytes = await buildShapefileZip(poly);
    return {
      kind: "file",
      filename: "shapefile.zip",
      mediaType: "application/zip",
      bytes,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Pack export
// ─────────────────────────────────────────────────────────────────────────────

const pack = defineFixturePack({
  manifest,
  // Cast: each generator declares its own params type, but
  // `DefineFixturePackOptions.generators` is typed as `Generator[]` which
  // defaults the param type to `void`. The runtime is happy as long as
  // `kind`/`outputs` line up — both verified by `defineFixturePack`.
  generators: [
    kmlGenerator,
    wktGenerator,
    geoJsonGenerator,
    shapefileZipGenerator,
  ] as unknown as Generator[],
});

export default pack;
export { pack };
