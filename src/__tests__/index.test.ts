/**
 * Tests for veroptima-qa-fixture-geo.
 *
 * Coverage:
 *   - factory shape (manifest, kinds, outputs)
 *   - determinism per kind (same seed+params -> byte-identical output)
 *   - KML/WKT/GeoJSON describe the SAME polygon for a (seed, params) pair
 *     (round-trip every form back to a coordinate ring and compare)
 *   - region: "overlap" intersects the seeded quilombo reference bbox;
 *     "clean" does not
 *   - shapefile-zip: extracts cleanly, .shp magic header is correct,
 *     byte-identical across two calls
 */
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import pack, {
  GeoParamsSchema,
  quilomboBbox,
  derivePolygon,
} from "../index";
import {
  isFileFixture,
  type FileFixture,
  type GenContext,
  type Generator,
} from "@qa-expert/fixture-pack-contract";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function noopLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeCtx(seed: string): GenContext {
  return { seed, locale: "pt-BR", logger: noopLogger() };
}

function getGen(kind: string): Generator<unknown, never> {
  const g = pack.generators.find((gen) => gen.kind === kind);
  if (!g) throw new Error(`no generator for kind ${kind}`);
  return g as Generator<unknown, never>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Parse `POLYGON((x y, x y, ...))` into a ring of [lng, lat] pairs. */
function parseWktPolygon(wkt: string): Array<[number, number]> {
  const m = /^POLYGON\s*\(\(\s*(.+?)\s*\)\)$/i.exec(wkt.trim());
  if (!m) throw new Error(`bad WKT: ${wkt}`);
  return m[1]!.split(",").map((pair) => {
    const [x, y] = pair.trim().split(/\s+/);
    return [Number(x), Number(y)] as [number, number];
  });
}

/** Extract the first `<coordinates>` content from KML. */
function parseKmlCoordinates(kml: string): Array<[number, number]> {
  const m = /<coordinates>\s*([\s\S]+?)\s*<\/coordinates>/.exec(kml);
  if (!m) throw new Error("KML has no <coordinates>");
  return m[1]!
    .trim()
    .split(/\s+/)
    .map((triple) => {
      const [x, y] = triple.split(",");
      return [Number(x), Number(y)] as [number, number];
    });
}

function parseGeoJsonRing(json: string): Array<[number, number]> {
  const obj = JSON.parse(json) as {
    geometry: { coordinates: number[][][] };
  };
  return obj.geometry.coordinates[0]!.map(([x, y]) => [x!, y!]);
}

function ringsApproxEqual(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
  eps = 1e-6,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]![0] - b[i]![0]) > eps) return false;
    if (Math.abs(a[i]![1] - b[i]![1]) > eps) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest / pack shape
// ─────────────────────────────────────────────────────────────────────────────

describe("pack shape", () => {
  test("manifest declares fixture-pack family @ 0.1.0", () => {
    expect(pack.manifest.family).toBe("fixture-pack");
    expect(pack.manifest.contractVersion).toBe("0.1.0");
    expect(pack.manifest.domain).toBe("geo");
  });

  test("exposes the four kinds with declared outputs", () => {
    const byKind = Object.fromEntries(
      pack.manifest.kinds.map((k) => [k.name, k.outputs]),
    );
    expect(byKind).toEqual({
      kml: "string",
      wkt: "string",
      geojson: "string",
      "shapefile-zip": "file",
    });
  });

  test("every manifest kind has a generator with matching outputs", () => {
    for (const k of pack.manifest.kinds) {
      const g = pack.generators.find((gen) => gen.kind === k.name);
      expect(g).toBeDefined();
      expect(g!.outputs).toBe(k.outputs);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GeoParamsSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("GeoParamsSchema", () => {
  test("applies defaults (maxHa=100, region=clean)", () => {
    const p = GeoParamsSchema.parse({});
    expect(p.maxHa).toBe(100);
    expect(p.region).toBe("clean");
  });

  test("rejects negative maxHa", () => {
    expect(() => GeoParamsSchema.parse({ maxHa: -1 })).toThrow();
  });

  test("rejects unknown region", () => {
    expect(() =>
      GeoParamsSchema.parse({ region: "nope" as unknown as "clean" }),
    ).toThrow();
  });

  test("rejects unknown keys (strict)", () => {
    expect(() =>
      GeoParamsSchema.parse({ maxHa: 50, foo: "bar" } as unknown as object),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism (cross-call replay) — per kind
// ─────────────────────────────────────────────────────────────────────────────

describe("determinism — string kinds", () => {
  const params = { maxHa: 80, region: "clean" as const };

  for (const kind of ["kml", "wkt", "geojson"] as const) {
    test(`${kind}: same (seed, params, locale) -> byte-identical string`, async () => {
      const gen = getGen(kind);
      const a = await gen.generate(params, makeCtx("seed-1"));
      const b = await gen.generate(params, makeCtx("seed-1"));
      expect(a).toEqual(b);
    });

    test(`${kind}: different seed -> different output`, async () => {
      const gen = getGen(kind);
      const a = await gen.generate(params, makeCtx("seed-1"));
      const b = await gen.generate(params, makeCtx("seed-2"));
      expect(a).not.toEqual(b);
    });
  }
});

describe("determinism — shapefile-zip (LOAD-BEARING)", () => {
  test("same seed -> byte-identical zip", async () => {
    const gen = getGen("shapefile-zip") as unknown as Generator<
      { maxHa: number; region: "clean" | "overlap" },
      FileFixture
    >;
    const params = { maxHa: 80, region: "clean" as const };
    const a = (await gen.generate(params, makeCtx("seed-shp"))) as FileFixture;
    const b = (await gen.generate(params, makeCtx("seed-shp"))) as FileFixture;
    expect(isFileFixture(a)).toBe(true);
    expect(isFileFixture(b)).toBe(true);
    expect(a.bytes.length).toBe(b.bytes.length);
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });

  test("different seed -> different bytes", async () => {
    const gen = getGen("shapefile-zip") as unknown as Generator<
      { maxHa: number; region: "clean" | "overlap" },
      FileFixture
    >;
    const params = { maxHa: 80, region: "clean" as const };
    const a = (await gen.generate(params, makeCtx("seed-A"))) as FileFixture;
    const b = (await gen.generate(params, makeCtx("seed-B"))) as FileFixture;
    expect(bytesEqual(a.bytes, b.bytes)).toBe(false);
  });

  test("filename + mediaType match the manifest contract", async () => {
    const gen = getGen("shapefile-zip") as unknown as Generator<
      { maxHa: number; region: "clean" | "overlap" },
      FileFixture
    >;
    const params = { maxHa: 80, region: "clean" as const };
    const file = (await gen.generate(
      params,
      makeCtx("seed-1"),
    )) as FileFixture;
    expect(file.filename).toBe("shapefile.zip");
    expect(file.mediaType).toBe("application/zip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Same-polygon across kinds
// ─────────────────────────────────────────────────────────────────────────────

describe("KML, WKT, GeoJSON describe the same polygon for the same (seed, params)", () => {
  const params = { maxHa: 80, region: "clean" as const };
  const seed = "seed-shared";

  test("rings match (round-trip via the three text forms)", async () => {
    const kml = await getGen("kml").generate(params, makeCtx(seed));
    const wkt = await getGen("wkt").generate(params, makeCtx(seed));
    const geojson = await getGen("geojson").generate(params, makeCtx(seed));

    const kmlRing = parseKmlCoordinates(kml as string);
    const wktRing = parseWktPolygon(wkt as string);
    const geoRing = parseGeoJsonRing(geojson as string);

    expect(kmlRing.length).toBe(5); // SW SE NE NW SW
    expect(ringsApproxEqual(kmlRing, wktRing)).toBe(true);
    expect(ringsApproxEqual(kmlRing, geoRing)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Region targeting — overlap intersects, clean does not
// ─────────────────────────────────────────────────────────────────────────────

describe("region branch-targeting", () => {
  const seeds = ["seed-a", "seed-b", "seed-c", "seed-d", "seed-e"];

  test("'overlap' polygons all intersect the quilombo reference bbox", () => {
    const ref = quilomboBbox();
    for (const seed of seeds) {
      const poly = derivePolygon(
        { maxHa: 80, region: "overlap" },
        makeCtx(seed),
      );
      const intersects =
        poly.bbox.minLng <= ref.maxLng &&
        poly.bbox.maxLng >= ref.minLng &&
        poly.bbox.minLat <= ref.maxLat &&
        poly.bbox.maxLat >= ref.minLat;
      expect(intersects).toBe(true);
    }
  });

  test("'clean' polygons never intersect the quilombo reference bbox", () => {
    const ref = quilomboBbox();
    for (const seed of seeds) {
      const poly = derivePolygon(
        { maxHa: 80, region: "clean" },
        makeCtx(seed),
      );
      const intersects =
        poly.bbox.minLng <= ref.maxLng &&
        poly.bbox.maxLng >= ref.minLng &&
        poly.bbox.minLat <= ref.maxLat &&
        poly.bbox.maxLat >= ref.minLat;
      expect(intersects).toBe(false);
    }
  });

  test("areaHa respects the maxHa cap", () => {
    for (const seed of seeds) {
      for (const region of ["clean", "overlap"] as const) {
        const poly = derivePolygon({ maxHa: 50, region }, makeCtx(seed));
        expect(poly.areaHa).toBeLessThanOrEqual(50);
        expect(poly.areaHa).toBeGreaterThan(0);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shapefile binary correctness
// ─────────────────────────────────────────────────────────────────────────────

describe("shapefile-zip binary correctness", () => {
  const params = { maxHa: 80, region: "clean" as const };

  test("zip extracts cleanly and contains the four members", async () => {
    const file = (await getGen("shapefile-zip").generate(
      params,
      makeCtx("seed-binary"),
    )) as FileFixture;

    const zip = await JSZip.loadAsync(file.bytes);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(
      ["parcela.dbf", "parcela.prj", "parcela.shp", "parcela.shx"].sort(),
    );
  });

  test(".shp first 4 bytes are 0x00 0x00 0x27 0x0A (file code 9994, big-endian)", async () => {
    const file = (await getGen("shapefile-zip").generate(
      params,
      makeCtx("seed-magic"),
    )) as FileFixture;
    const zip = await JSZip.loadAsync(file.bytes);
    const shp = await zip.file("parcela.shp")!.async("uint8array");
    expect(shp[0]).toBe(0x00);
    expect(shp[1]).toBe(0x00);
    expect(shp[2]).toBe(0x27);
    expect(shp[3]).toBe(0x0a);
  });

  test(".prj is a recognisable WGS84 GEOGCS WKT", async () => {
    const file = (await getGen("shapefile-zip").generate(
      params,
      makeCtx("seed-prj"),
    )) as FileFixture;
    const zip = await JSZip.loadAsync(file.bytes);
    const prj = await zip.file("parcela.prj")!.async("string");
    expect(prj).toContain("GEOGCS");
    expect(prj).toContain("WGS 84");
  });
});
