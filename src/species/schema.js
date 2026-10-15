// Server-side safety net: a $jsonSchema validator on the collection.
// Even if a client bypasses the app's validation, MongoDB rejects bad docs
// (error code 121 "Document failed validation").
import { KINGDOMS, STATUSES, LIMITS, SCIENTIFIC_NAME_RE } from "./validation.js";
import { SPECIES_COLLECTION } from "../config.js";

export const speciesJsonSchema = {
  bsonType: "object",
  title: "Species",
  required: ["commonName", "scientificName", "kingdom", "conservationStatus", "createdAt", "updatedAt"],
  additionalProperties: false,
  properties: {
    _id: { bsonType: "objectId" },
    commonName: {
      bsonType: "string",
      minLength: LIMITS.commonName.min,
      maxLength: LIMITS.commonName.max,
      description: "required common name, 2-100 chars",
    },
    scientificName: {
      bsonType: "string",
      pattern: SCIENTIFIC_NAME_RE.source,
      description: "required binomial name 'Genus species'",
    },
    kingdom: { enum: KINGDOMS, description: "one of the biological kingdoms" },
    conservationStatus: { enum: Object.keys(STATUSES), description: "IUCN Red List code" },
    population: {
      bsonType: ["int", "long", "double"],
      minimum: 0,
      maximum: LIMITS.populationMax,
      description: "optional non-negative population estimate",
    },
    habitats: {
      bsonType: "array",
      maxItems: LIMITS.habitatsMax,
      uniqueItems: true,
      items: { bsonType: "string", minLength: LIMITS.habitat.min, maxLength: LIMITS.habitat.max },
    },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
};

/** Create the collection (or update its validator) and the indexes. Idempotent. */
export async function ensureSpeciesCollection(db) {
  const exists = (await db.listCollections({ name: SPECIES_COLLECTION }).toArray()).length > 0;
  const options = {
    validator: { $jsonSchema: speciesJsonSchema },
    validationLevel: "strict",
    validationAction: "error",
  };
  if (exists) {
    await db.command({ collMod: SPECIES_COLLECTION, ...options });
  } else {
    await db.createCollection(SPECIES_COLLECTION, options);
  }
  const col = db.collection(SPECIES_COLLECTION);
  await col.createIndex({ scientificName: 1 }, { unique: true, name: "uniq_scientificName" });
  await col.createIndex({ kingdom: 1, conservationStatus: 1 }, { name: "kingdom_status" });
  return col;
}

