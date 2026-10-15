// Lab 4 & 6 - Step 2: Stop the primary, measure election time and winner.
//
// For each failure mode we run N trials:
//   stop -> `docker stop`  (SIGTERM: graceful shutdown, primary steps down and hands off)
//   kill -> `docker kill`  (SIGKILL: crash, secondaries must wait electionTimeoutMillis)
//
// Election time = from the moment the docker command is issued until another
// member reports isWritablePrimary:true (polled every 100 ms).
//
// Usage: node src/election-test.js [--trials 3] [--modes stop,kill]
import { MongoClient } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { MONGO_URI, DB_NAME, containerFor } from "./config.js";
import { stopContainer, killContainer, startContainer } from "./lib/docker.js";
import { getPrimary, waitForNewPrimary, waitForHealthy, rsStatus, closeProbes, sleep } from "./lib/rs.js";
import { seed } from "./seed.js";

const { values: args } = parseArgs({
  options: { trials: { type: "string", default: "3" }, modes: { type: "string", default: "stop,kill" } },
});
const TRIALS = Number(args.trials);
const MODES = args.modes.split(",").map((s) => s.trim());

const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;
const short = (host) => `${containerFor(host)} (${host.split(":")[1]})`;

async function runTrial(client, mode, n) {
  const markers = client.db(DB_NAME).collection("failover_markers");

  console.log(`\n=== ${mode.toUpperCase()} trial ${n}/${TRIALS} ===`);
  const healthy = await waitForHealthy();
  const beforeTerm = healthy.term;

  // 1) write data that must survive the failover
  const marker = { mode, trial: n, at: new Date() };
  const { insertedId } = await markers.insertOne(marker, { writeConcern: { w: "majority" } });
  const speciesBefore = await client.db(DB_NAME).collection("species").countDocuments();

  // 2) find and take down the primary
  const oldPrimary = await getPrimary();
  const container = containerFor(oldPrimary);
  console.log(`  primary before: ${short(oldPrimary)}  term=${beforeTerm}  species=${speciesBefore}`);
  console.log(`  docker ${mode} ${container} ...`);

  const t0 = performance.now();
  const action = mode === "kill" ? killContainer(container) : stopContainer(container);
  let dockerDoneMs = null;
  action.then(() => (dockerDoneMs = performance.now() - t0));

  // 3) poll the remaining members until one becomes primary
  const winner = await waitForNewPrimary(oldPrimary, t0, { pollMs: 100 });
  await action;

  // 4) collect election details from the winner
  const st = await rsStatus(winner.host);
  const m = st?.electionCandidateMetrics ?? {};
  const afterTerm = st?.term;

  // 5) verify no data loss: marker + species count readable via the driver (follows the new primary)
  const markerFound = !!(await markers.findOne({ _id: insertedId }));
  const speciesAfter = await client.db(DB_NAME).collection("species").countDocuments();

  const result = {
    mode,
    trial: n,
    oldPrimary,
    oldPrimaryContainer: container,
    newPrimary: winner.host,
    newPrimaryContainer: containerFor(winner.host),
    electionMs: Math.round(winner.elapsedMs),
    dockerCommandMs: dockerDoneMs === null ? null : Math.round(dockerDoneMs),
    termBefore: beforeTerm,
    termAfter: afterTerm,
    lastElectionReason: m.lastElectionReason ?? null,
    electionTimeoutMillis: m.electionTimeoutMillis ?? null,
    numVotesNeeded: m.numVotesNeeded ?? null,
    markerSurvived: markerFound,
    speciesBefore,
    speciesAfter,
  };

  console.log(`  NEW PRIMARY: ${short(winner.host)} after ${fmt(winner.elapsedMs)}`);
  console.log(
    `  term ${beforeTerm} -> ${afterTerm}, reason=${result.lastElectionReason}, ` +
      `docker ${mode} returned after ${dockerDoneMs === null ? "?" : fmt(dockerDoneMs)}`
  );
  console.log(`  data check: marker survived=${markerFound}, species ${speciesBefore} -> ${speciesAfter}`);

  // 6) bring the old primary back; it rejoins as a SECONDARY
  console.log(`  docker start ${container} (rejoins as secondary)`);
  await startContainer(container);
  await waitForHealthy();
  await sleep(2000); // let heartbeats settle before the next trial
  return result;
}

function summarize(results) {
  const out = {};
  for (const mode of MODES) {
    const rs = results.filter((r) => r.mode === mode);
    if (!rs.length) continue;
    const ms = rs.map((r) => r.electionMs);
    out[mode] = {
      trials: rs.length,
      avgMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
      minMs: Math.min(...ms),
      maxMs: Math.max(...ms),
      winners: rs.map((r) => r.newPrimaryContainer),
      reasons: [...new Set(rs.map((r) => r.lastElectionReason))],
      allDataSurvived: rs.every((r) => r.markerSurvived && r.speciesAfter === r.speciesBefore),
    };
  }
  return out;
}

async function main() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  await client.connect();
  try {
    console.log("Election experiment - replica set rs0, default electionTimeoutMillis, equal priorities");
    const s = await seed(client);
    console.log(`Seeded data: ${s.total} species in biodiversity.species`);

    const results = [];
    for (const mode of MODES) {
      for (let i = 1; i <= TRIALS; i++) results.push(await runTrial(client, mode, i));
    }

    console.log("\n=================== RESULTS ===================");
    console.log("mode  trial  old primary        new primary        election   term     reason");
    for (const r of results) {
      console.log(
        `${r.mode.padEnd(5)} ${String(r.trial).padEnd(6)} ${short(r.oldPrimary).padEnd(18)} ${short(r.newPrimary).padEnd(18)} ` +
          `${fmt(r.electionMs).padEnd(10)} ${`${r.termBefore}->${r.termAfter}`.padEnd(8)} ${r.lastElectionReason}`
      );
    }
    const summary = summarize(results);
    console.log("\nSummary:");
    for (const [mode, s] of Object.entries(summary)) {
      console.log(
        `  ${mode}: avg ${fmt(s.avgMs)} (min ${fmt(s.minMs)}, max ${fmt(s.maxMs)}), winners: ${s.winners.join(", ")}, ` +
          `reasons: ${s.reasons.join("/")}, no data lost: ${s.allDataSurvived}`
      );
    }

    await mkdir("results", { recursive: true });
    await writeFile(
      "results/election.json",
      JSON.stringify({ ranAt: new Date().toISOString(), summary, results }, null, 2)
    );
    console.log("\nSaved results/election.json");
  } finally {
    await client.close();
    await closeProbes();
  }
}

main().catch((err) => {
  console.error("Election experiment failed:", err);
  process.exitCode = 1;
});

