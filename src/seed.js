// Seeds the species collection with realistic data (idempotent upserts).
// Used before the election experiment so the replica set holds real data.
import { MongoClient } from "mongodb";
import { fileURLToPath } from "node:url";
import { MONGO_URI, DB_NAME } from "./config.js";
import { ensureSpeciesCollection } from "./species/schema.js";
import { validateCreate } from "./species/validation.js";

export const SEED = [
  ["Snow Leopard", "Panthera uncia", "Animalia", "VU", 4000, ["mountains", "alpine meadows"]],
  ["Giant Panda", "Ailuropoda melanoleuca", "Animalia", "VU", 1864, ["bamboo forest"]],
  ["Bald Eagle", "Haliaeetus leucocephalus", "Animalia", "LC", 316700, ["coasts", "lakes", "rivers"]],
  ["African Elephant", "Loxodonta africana", "Animalia", "EN", 415000, ["savanna", "forest"]],
  ["Sumatran Orangutan", "Pongo abelii", "Animalia", "CR", 14000, ["tropical rainforest"]],
  ["Blue Whale", "Balaenoptera musculus", "Animalia", "EN", 15000, ["open ocean"]],
  ["Axolotl", "Ambystoma mexicanum", "Animalia", "CR", 1000, ["freshwater lakes", "canals"]],
  ["Vaquita", "Phocoena sinus", "Animalia", "CR", 10, ["gulf of california"]],
  ["Hawksbill Turtle", "Eretmochelys imbricata", "Animalia", "CR", 23000, ["coral reefs"]],
  ["Red Panda", "Ailurus fulgens", "Animalia", "EN", 10000, ["temperate forest"]],
  ["Gray Wolf", "Canis lupus", "Animalia", "LC", 200000, ["forest", "tundra", "grassland"]],
  ["Monarch Butterfly", "Danaus plexippus", "Animalia", "VU", null, ["meadows", "gardens"]],
  ["Komodo Dragon", "Varanus komodoensis", "Animalia", "EN", 3458, ["dry forest", "savanna"]],
  ["Kakapo", "Strigops habroptilus", "Animalia", "CR", 247, ["island forest"]],
  ["Polar Bear", "Ursus maritimus", "Animalia", "VU", 26000, ["sea ice", "tundra"]],
  ["Thylacine", "Thylacinus cynocephalus", "Animalia", "EX", 0, ["eucalyptus forest"]],
  ["Venus Flytrap", "Dionaea muscipula", "Plantae", "VU", 300000, ["wetlands", "pine savanna"]],
  ["Giant Sequoia", "Sequoiadendron giganteum", "Plantae", "EN", 80000, ["mountain forest"]],
  ["Baobab", "Adansonia digitata", "Plantae", "LC", null, ["savanna"]],
  ["Wollemi Pine", "Wollemia nobilis", "Plantae", "CR", 60, ["rainforest canyon"]],
  ["Corpse Flower", "Amorphophallus titanum", "Plantae", "EN", 1000, ["tropical rainforest"]],
  ["Fly Agaric", "Amanita muscaria", "Fungi", "NE", null, ["birch forest", "pine forest"]],
  ["Willow Gloveweed", "Hypocreopsis amplectens", "Fungi", "CR", null, ["willow scrub"]],
  ["Giant Kelp", "Macrocystis pyrifera", "Chromista", "NE", null, ["kelp forest"]],
  ["Golden Toad", "Incilius periglenes", "Animalia", "EX", 0, ["cloud forest"]],
];

export async function seed(client) {
  const db = client.db(DB_NAME);
  const col = await ensureSpeciesCollection(db);
  const now = new Date();
  const ops = SEED.map(([commonName, scientificName, kingdom, conservationStatus, population, habitats]) => {
    const input = { commonName, scientificName, kingdom, conservationStatus, habitats };
    if (population !== null) input.population = population;
    const v = validateCreate(input);
    if (!v.ok) throw new Error(`Seed row invalid (${scientificName}): ${v.errors.join("; ")}`);
    return {
      updateOne: {
        filter: { scientificName },
        update: { $set: { ...v.value, updatedAt: now }, $setOnInsert: { createdAt: now } },
        upsert: true,
      },
    };
  });
  const res = await col.bulkWrite(ops, { writeConcern: { w: "majority" } });
  return { upserted: res.upsertedCount, modified: res.modifiedCount, total: await col.countDocuments() };
}

// Run directly: node src/seed.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const r = await seed(client);
    console.log(`Seeded species: ${r.upserted} inserted, ${r.modified} updated, ${r.total} total in collection.`);
  } finally {
    await client.close();
  }
}

