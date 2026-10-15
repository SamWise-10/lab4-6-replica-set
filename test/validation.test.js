// Unit tests for the species validation layer (no database needed).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  validateCreate,
  validateUpdate,
  parseIdentifier,
  validateListOptions,
} from "../src/species/validation.js";

const valid = () => ({
  commonName: "Snow Leopard",
  scientificName: "Panthera uncia",
  kingdom: "Animalia",
  conservationStatus: "VU",
  population: 4000,
  habitats: ["mountains"],
});

// ---------- create ----------

test("create: accepts a valid species", () => {
  const r = validateCreate(valid());
  assert.equal(r.ok, true);
  assert.equal(r.value.scientificName, "Panthera uncia");
});

test("create: normalizes whitespace, enum case and habitats", () => {
  const r = validateCreate({
    ...valid(),
    commonName: "  Snow   Leopard ",
    kingdom: "animalia",
    conservationStatus: "vu",
    population: "4000",
    habitats: "Mountains, alpine meadows, mountains,",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.commonName, "Snow Leopard");
  assert.equal(r.value.kingdom, "Animalia");
  assert.equal(r.value.conservationStatus, "VU");
  assert.equal(r.value.population, 4000);
  assert.deepEqual(r.value.habitats, ["mountains", "alpine meadows"]);
});

test("create: population and habitats are optional", () => {
  const { population, habitats, ...rest } = valid();
  const r = validateCreate(rest);
  assert.equal(r.ok, true);
  assert.equal(r.value.population, undefined);
  assert.deepEqual(r.value.habitats, []);
});

test("create: reports every missing required field", () => {
  const r = validateCreate({});
  assert.equal(r.ok, false);
  for (const f of ["commonName", "scientificName", "kingdom", "conservationStatus"]) {
    assert.ok(r.errors.some((e) => e.startsWith(`${f}: is required`)), `missing ${f}`);
  }
});

test("create: collects ALL errors at once", () => {
  const r = validateCreate({
    commonName: "X",
    scientificName: "panthera Uncia",
    kingdom: "Dinosauria",
    conservationStatus: "SAFE",
    population: -5,
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 5);
});

for (const bad of ["panthera uncia", "Panthera Uncia", "Panthera", "Panthera uncia 123", "Panthera  ", 42]) {
  test(`create: rejects scientificName ${JSON.stringify(bad)}`, () => {
    const r = validateCreate({ ...valid(), scientificName: bad });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith("scientificName")));
  });
}

test("create: accepts trinomial (subspecies) scientific names", () => {
  assert.equal(validateCreate({ ...valid(), scientificName: "Panthera tigris altaica" }).ok, true);
});

for (const bad of [-1, 1.5, "abc", "12abc", true, 1e13]) {
  test(`create: rejects population ${JSON.stringify(bad)}`, () => {
    const r = validateCreate({ ...valid(), population: bad });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith("population")));
  });
}

test("create: rejects commonName with digits or symbols", () => {
  const r = validateCreate({ ...valid(), commonName: "Leopard<script>" });
  assert.equal(r.ok, false);
});

test("create: rejects invalid habitats entries", () => {
  const r = validateCreate({ ...valid(), habitats: ["ok", 42, "x"] });
  assert.equal(r.ok, false);
  assert.equal(r.errors.filter((e) => e.startsWith("habitats")).length, 2);
});

test("create: rejects more than 20 habitats", () => {
  const habitats = Array.from({ length: 21 }, (_, i) => `habitat ${String.fromCharCode(97 + i)}`);
  assert.equal(validateCreate({ ...valid(), habitats }).ok, false);
});

test("create: rejects unknown and immutable fields", () => {
  const r = validateCreate({ ...valid(), color: "grey", _id: "x" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("color: unknown field")));
  assert.ok(r.errors.some((e) => e.startsWith("_id: cannot be set")));
});

test("create: rejects non-object input", () => {
  assert.equal(validateCreate(null).ok, false);
  assert.equal(validateCreate([valid()]).ok, false);
});

// ---------- update ----------

test("update: accepts a partial patch", () => {
  const r = validateUpdate({ conservationStatus: "en", population: "3500" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { conservationStatus: "EN", population: 3500 });
  assert.deepEqual(r.unset, []);
});

test("update: rejects an empty patch", () => {
  assert.equal(validateUpdate({}).ok, false);
});

test("update: rejects blanking a required field", () => {
  const r = validateUpdate({ kingdom: "" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e === "kingdom: cannot be empty"));
});

test("update: rejects immutable fields", () => {
  const r = validateUpdate({ createdAt: "2020-01-01" });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].startsWith("createdAt: cannot be set or changed"));
});

test("update: empty population unsets it; empty habitats clears the list", () => {
  const r = validateUpdate({ population: "", habitats: "" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unset, ["population"]);
  assert.deepEqual(r.value.habitats, []);
});

// ---------- identifiers ----------

test("identifier: accepts an ObjectId", () => {
  const id = new ObjectId().toHexString();
  const r = parseIdentifier(id);
  assert.equal(r.ok, true);
  assert.ok(r.filter._id instanceof ObjectId);
});

test("identifier: accepts a scientific name", () => {
  assert.deepEqual(parseIdentifier("  Panthera   uncia ").filter, { scientificName: "Panthera uncia" });
});

test("identifier: rejects garbage and injection attempts", () => {
  for (const bad of ["", "   ", "DROP TABLE species;", '{"$ne":null}', undefined, 12]) {
    assert.equal(parseIdentifier(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---------- list options ----------

test("list: builds filters and escapes regex metacharacters in search", () => {
  const r = validateListOptions({ kingdom: "plantae", status: "en", search: "a.b*", limit: "5" });
  assert.equal(r.ok, true);
  assert.equal(r.filter.kingdom, "Plantae");
  assert.equal(r.filter.conservationStatus, "EN");
  assert.equal(r.filter.$or[0].commonName.$regex, "a\\.b\\*");
  assert.equal(r.limit, 5);
});

test("list: rejects invalid filters", () => {
  const r = validateListOptions({ kingdom: "Minerals", status: "X", search: "a", limit: "9999" });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4);
});

