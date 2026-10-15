#!/usr/bin/env node
// Lab 4 & 6 - Step 4: Species CRUD command-line tool.
//
// Usage: node src/species.js <command> [options]   (run with --help for details)
import { parseArgs } from "node:util";
import { MongoServerError } from "mongodb";
import { SpeciesRepository, ValidationError, NotFoundError } from "./species/repository.js";
import { STATUSES } from "./species/validation.js";

const EXIT = { OK: 0, VALIDATION: 1, NOT_FOUND: 2, DB: 3 };

const HELP = `
Species CRUD tool  (database: biodiversity, collection: species)

Commands:
  create  --commonName <s> --scientificName <"Genus species"> --kingdom <k> --status <IUCN>
          [--population <n>] [--habitats "forest,wetland"]
  list    [--kingdom <k>] [--status <IUCN>] [--search <text>] [--limit <n>]
  get     <id | "Genus species">
  update  <id | "Genus species"> [--commonName ..] [--scientificName ..] [--kingdom ..]
          [--status ..] [--population <n|"">] [--habitats <list|"">]
  delete  <id | "Genus species">
  demo    run every CRUD operation, including invalid input, against the live replica set

Kingdoms: Animalia, Plantae, Fungi, Protista, Chromista, Bacteria, Archaea
IUCN:     ${Object.entries(STATUSES).map(([k, v]) => `${k}=${v}`).join(", ")}

Exit codes: 0 ok, 1 validation error, 2 not found, 3 database error
`;

const OPTIONS = {
  commonName: { type: "string" },
  scientificName: { type: "string" },
  kingdom: { type: "string" },
  status: { type: "string" },
  population: { type: "string" },
  habitats: { type: "string" },
  search: { type: "string" },
  limit: { type: "string" },
  help: { type: "boolean", short: "h" },
};

// ---------- output helpers ----------

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function printDoc(d) {
  const status = `${d.conservationStatus} (${STATUSES[d.conservationStatus]})`;
  console.log(`  _id:                ${d._id}`);
  console.log(`  commonName:         ${d.commonName}`);
  console.log(`  scientificName:     ${d.scientificName}`);
  console.log(`  kingdom:            ${d.kingdom}`);
  console.log(`  conservationStatus: ${status}`);
  console.log(`  population:         ${d.population ?? c.dim("(unknown)")}`);
  console.log(`  habitats:           ${d.habitats?.length ? d.habitats.join(", ") : c.dim("(none)")}`);
  console.log(`  createdAt:          ${d.createdAt?.toISOString()}`);
  console.log(`  updatedAt:          ${d.updatedAt?.toISOString()}`);
}

function printTable(docs) {
  if (!docs.length) return console.log(c.dim("  (no species match)"));
  const rows = docs.map((d) => [
    String(d._id),
    d.commonName,
    d.scientificName,
    d.kingdom,
    d.conservationStatus,
    d.population ?? "-",
  ]);
  const head = ["_id", "commonName", "scientificName", "kingdom", "status", "population"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => "  " + r.map((v, i) => String(v).padEnd(w[i])).join("  ");
  console.log(c.bold(line(head)));
  console.log("  " + w.map((n) => "-".repeat(n)).join("  "));
  rows.forEach((r) => console.log(line(r)));
  console.log(c.dim(`  ${docs.length} species`));
}

function fieldsFrom(values) {
  const out = {};
  for (const k of ["commonName", "scientificName", "kingdom", "population", "habitats"]) {
    if (values[k] !== undefined) out[k] = values[k];
  }
  if (values.status !== undefined) out.conservationStatus = values.status;
  return out;
}

// ---------- commands ----------

const commands = {
  async create(repo, { values }) {
    const doc = await repo.create(fieldsFrom(values));
    console.log(c.green("✔ Created species:"));
    printDoc(doc);
  },

  async list(repo, { values }) {
    const docs = await repo.list({
      kingdom: values.kingdom,
      status: values.status,
      search: values.search,
      limit: values.limit,
    });
    printTable(docs);
  },

  async get(repo, { positionals }) {
    const doc = await repo.get(positionals[0]);
    printDoc(doc);
  },

  async update(repo, { values, positionals }) {
    const doc = await repo.update(positionals[0], fieldsFrom(values));
    console.log(c.green("✔ Updated species:"));
    printDoc(doc);
  },

  async delete(repo, { positionals }) {
    const doc = await repo.remove(positionals[0]);
    console.log(c.green(`✔ Deleted ${doc.commonName} (${doc.scientificName}) [${doc._id}]`));
  },

  async demo(repo) {
    await runDemo(repo);
  },
};

// ---------- scripted demo ----------

async function step(title, fn) {
  console.log("\n" + c.cyan(c.bold(`▶ ${title}`)));
  try {
    await fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log(c.yellow("✘ Rejected by app validation:"));
      err.errors.forEach((e) => console.log(c.yellow(`    - ${e}`)));
    } else if (err instanceof NotFoundError) {
      console.log(c.yellow(`✘ ${err.message}`));
    } else if (err instanceof MongoServerError) {
      console.log(c.yellow(`✘ Rejected by MongoDB server: code ${err.code} (${err.codeName}) - ${err.message}`));
      const rules = err.errInfo?.details?.schemaRulesNotSatisfied;
      if (rules) {
        for (const r of rules) {
          const props = r.propertiesNotSatisfied?.map((p) => p.propertyName).join(", ");
          const missing = r.missingProperties?.join(", ");
          const extra = r.additionalProperties?.join(", ");
          console.log(
            c.yellow(
              `    - rule '${r.operatorName}'` +
                (props ? ` failed for: ${props}` : "") +
                (missing ? ` missing: ${missing}` : "") +
                (extra ? ` unexpected: ${extra}` : "")
            )
          );
        }
      }
    } else {
      throw err;
    }
  }
}

async function runDemo(repo) {
  const A = "Panthera uncia";
  const B = "Dionaea muscipula";
  // clean up from previous demo runs so the demo is repeatable
  await repo.col.deleteMany({ scientificName: { $in: [A, B] } }, { writeConcern: { w: "majority" } });

  console.log(c.bold("Species CRUD demo - connected to replica set, db 'biodiversity'"));

  await step("CREATE a valid species (Snow Leopard)", async () => {
    const d = await repo.create({
      commonName: "  Snow   Leopard ",
      scientificName: A,
      kingdom: "animalia",
      conservationStatus: "vu",
      population: "4000",
      habitats: "Mountains, alpine meadows, mountains",
    });
    console.log(c.green("✔ Created (note normalization: spaces trimmed, enums fixed, habitats deduplicated):"));
    printDoc(d);
  });

  await step("CREATE a second species (Venus Flytrap)", async () => {
    const d = await repo.create({
      commonName: "Venus Flytrap",
      scientificName: B,
      kingdom: "Plantae",
      conservationStatus: "VU",
      population: 300000,
      habitats: ["wetlands", "pine savanna"],
    });
    console.log(c.green(`✔ Created ${d.commonName} [${d._id}]`));
  });

  await step("CREATE duplicate scientificName (should fail: unique index)", async () => {
    await repo.create({ commonName: "Ounce", scientificName: A, kingdom: "Animalia", conservationStatus: "VU" });
  });

  await step("CREATE with many invalid fields (should fail: app validation lists ALL errors)", async () => {
    await repo.create({
      commonName: "X",
      scientificName: "panthera Uncia",
      kingdom: "Dinosauria",
      conservationStatus: "SAFE",
      population: -5,
      habitats: ["ok habitat", 42],
      color: "grey",
    });
  });

  await step("CREATE with missing required fields (should fail)", async () => {
    await repo.create({ commonName: "Mystery Animal" });
  });

  await step("BYPASS app validation: raw insertOne of a bad document (should fail: $jsonSchema, code 121)", async () => {
    await repo.col.insertOne({
      commonName: "Bad Doc",
      scientificName: "not a binomial",
      kingdom: "Robots",
      conservationStatus: "LC",
      population: -1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  await step("READ: list all Vulnerable species", async () => {
    printTable(await repo.list({ status: "VU" }));
  });

  await step("READ: search 'leopard' (input is regex-escaped)", async () => {
    printTable(await repo.list({ search: "leopard" }));
  });

  await step("READ: get by scientific name", async () => {
    printDoc(await repo.get(A));
  });

  await step("READ: list with invalid filters (should fail)", async () => {
    await repo.list({ kingdom: "Minerals", limit: "9999" });
  });

  await step("UPDATE: Snow Leopard status VU -> EN, population 4000 -> 3500", async () => {
    const d = await repo.update(A, { conservationStatus: "EN", population: "3500" });
    console.log(c.green("✔ Updated:"));
    printDoc(d);
  });

  await step("UPDATE with invalid data and immutable field (should fail)", async () => {
    await repo.update(A, { population: "lots", createdAt: "2020-01-01", kingdom: "" });
  });

  await step("UPDATE a species that does not exist (should fail: not found)", async () => {
    await repo.update("Felis imaginaria", { population: 1 });
  });

  await step("DELETE Venus Flytrap", async () => {
    const d = await repo.remove(B);
    console.log(c.green(`✔ Deleted ${d.commonName} (${d.scientificName})`));
  });

  await step("READ deleted species (should fail: not found)", async () => {
    await repo.get(B);
  });

  await step("DELETE with a malformed identifier (should fail)", async () => {
    await repo.remove("DROP TABLE species;");
  });

  console.log("\n" + c.green(c.bold("Demo complete.")));
}

// ---------- entry point ----------

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(c.red(`✘ ${err.message}`));
    console.error(HELP);
    return EXIT.VALIDATION;
  }
  const [cmd, ...positionals] = parsed.positionals;
  if (parsed.values.help || !cmd) {
    console.log(HELP);
    return EXIT.OK;
  }
  const handler = commands[cmd];
  if (!handler) {
    console.error(c.red(`✘ Unknown command '${cmd}'`));
    console.error(HELP);
    return EXIT.VALIDATION;
  }
  if (["get", "update", "delete"].includes(cmd) && positionals.length !== 1) {
    console.error(c.red(`✘ '${cmd}' needs exactly one identifier (ObjectId or "Genus species"; quote names with spaces)`));
    return EXIT.VALIDATION;
  }

  const repo = new SpeciesRepository();
  try {
    await repo.connect();
    await handler(repo, { values: parsed.values, positionals });
    return EXIT.OK;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(c.red("✘ " + err.message));
      return EXIT.VALIDATION;
    }
    if (err instanceof NotFoundError) {
      console.error(c.red("✘ " + err.message));
      return EXIT.NOT_FOUND;
    }
    console.error(c.red(`✘ Database error: ${err.message}`));
    return EXIT.DB;
  } finally {
    await repo.close();
  }
}

process.exitCode = await main(process.argv.slice(2));

