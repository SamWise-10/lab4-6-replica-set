// Data-access layer for species. All inputs are validated before they reach
// MongoDB; all writes use w:"majority" so acknowledged data survives failover.
import { MongoClient, MongoServerError } from "mongodb";
import { MONGO_URI, DB_NAME } from "../config.js";
import { ensureSpeciesCollection } from "./schema.js";
import { validateCreate, validateUpdate, parseIdentifier, validateListOptions } from "./validation.js";

export class ValidationError extends Error {
  constructor(errors) {
    super(`Validation failed:\n  - ${errors.join("\n  - ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export class NotFoundError extends Error {
  constructor(what) {
    super(`Not found: ${what}`);
    this.name = "NotFoundError";
  }
}

const WRITE_OPTS = { writeConcern: { w: "majority", wtimeoutMS: 5000 } };

function translateDbError(err, doc) {
  if (err instanceof MongoServerError && err.code === 11000) {
    return new ValidationError([`scientificName: a species named "${doc?.scientificName}" already exists`]);
  }
  if (err instanceof MongoServerError && err.code === 121) {
    return new ValidationError(["server: document failed the collection's $jsonSchema validation"]);
  }
  return err;
}

export class SpeciesRepository {
  constructor(client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 })) {
    this.client = client;
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(DB_NAME);
    this.col = await ensureSpeciesCollection(this.db);
    return this;
  }

  close() {
    return this.client.close();
  }

  async create(input) {
    const v = validateCreate(input);
    if (!v.ok) throw new ValidationError(v.errors);
    const now = new Date();
    const doc = { ...v.value, createdAt: now, updatedAt: now };
    try {
      const { insertedId } = await this.col.insertOne(doc, WRITE_OPTS);
      return { _id: insertedId, ...doc };
    } catch (err) {
      throw translateDbError(err, doc);
    }
  }

  async list(options = {}) {
    const v = validateListOptions(options);
    if (!v.ok) throw new ValidationError(v.errors);
    return this.col.find(v.filter).sort({ commonName: 1 }).limit(v.limit).toArray();
  }

  async get(identifier) {
    const id = parseIdentifier(identifier);
    if (!id.ok) throw new ValidationError(id.errors);
    const doc = await this.col.findOne(id.filter);
    if (!doc) throw new NotFoundError(identifier);
    return doc;
  }

  async update(identifier, patch) {
    const id = parseIdentifier(identifier);
    const v = validateUpdate(patch);
    const errors = [...(id.ok ? [] : id.errors), ...(v.ok ? [] : v.errors)];
    if (errors.length) throw new ValidationError(errors);

    const update = { $set: { ...v.value, updatedAt: new Date() } };
    if (v.unset.length) update.$unset = Object.fromEntries(v.unset.map((f) => [f, ""]));
    try {
      const doc = await this.col.findOneAndUpdate(id.filter, update, {
        ...WRITE_OPTS,
        returnDocument: "after",
      });
      if (!doc) throw new NotFoundError(identifier);
      return doc;
    } catch (err) {
      throw translateDbError(err, v.value);
    }
  }

  async remove(identifier) {
    const id = parseIdentifier(identifier);
    if (!id.ok) throw new ValidationError(id.errors);
    const doc = await this.col.findOneAndDelete(id.filter, WRITE_OPTS);
    if (!doc) throw new NotFoundError(identifier);
    return doc;
  }
}

