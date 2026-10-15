// Lab 4 & 6 - Step 3: write with w:1 and w:"majority" and compare.
//
// Part A (healthy cluster): latency of N inserts with w:1 vs w:"majority".
// Part B (degraded cluster): kill both secondaries, then
//    - w:1 insert         -> acknowledged immediately (only the primary has it)
//    - w:"majority" insert -> WriteConcernError after wtimeout (but written locally!)
//    - the primary steps down once it can't see a majority
//    - ROLLBACK: kill old primary, restart secondaries (they elect a new primary
//      without those writes), write new data, restart the old primary -> its
//      un-replicated writes are rolled back.
//
// Usage: node src/write-concern-test.js [--n 200] [--skip-rollback]
import { MongoClient, ObjectId } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { MONGO_URI, DB_NAME, MEMBERS, containerFor } from "./config.js";
import { killContainer, startContainer, execInContainer } from "./lib/docker.js";
import { waitForHealthy, waitForNewPrimary, hello, closeProbes, sleep } from "./lib/rs.js";

const { values: args } = parseArgs({
  options: {
    n: { type: "string", default: "200" },
    "skip-rollback": { type: "boolean", default: false },
  },
});
const N = Number(args.n);
const COLL = "write_concern_lab";
const short = (h) => `${containerFor(h)} (${h.split(":")[1]})`;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    avgMs: +avg.toFixed(3),
    p50Ms: +pct(50).toFixed(3),
    p95Ms: +pct(95).toFixed(3),
    maxMs: +s[s.length - 1].toFixed(3),
    totalMs: +s.reduce((a, b) => a + b, 0).toFixed(1),
  };
}

// ---------------------------------------------------------------------------
async function partA(client) {
  console.log(`\n===== PART A: latency on a healthy cluster (${N} inserts each) =====`);
  await waitForHealthy();
  const col = client.db(DB_NAME).collection(COLL);
  await col.deleteMany({}, { writeConcern: { w: "majority" } });

  // warm-up so connection setup doesn't skew the first measurements
  for (let i = 0; i < 20; i++) await col.insertOne({ warmup: true, i }, { writeConcern: { w: "majority" } });

  const results = {};
  // interleave rounds to cancel out drift (w1, majority, w1, majority, ...)
  const times = { "w:1": [], 'w:"majority"': [] };
  for (let i = 0; i < N; i++) {
    for (const [label, wc] of [
      ["w:1", { w: 1 }],
      ['w:"majority"', { w: "majority" }],
    ]) {
      const t = performance.now();
      await col.insertOne({ partA: true, label, i, payload: "x".repeat(200) }, { writeConcern: wc });
      times[label].push(performance.now() - t);
    }
  }
  for (const [label, arr] of Object.entries(times)) results[label] = stats(arr);

  console.log("  write concern     avg      p50      p95      max     total");
  for (const [label, s] of Object.entries(results)) {
    console.log(
      `  ${label.padEnd(14)} ${s.avgMs.toFixed(2).padStart(6)}ms ${s.p50Ms.toFixed(2).padStart(6)}ms ` +
        `${s.p95Ms.toFixed(2).padStart(6)}ms ${s.maxMs.toFixed(2).padStart(6)}ms ${String(s.totalMs).padStart(7)}ms`
    );
  }
  const ratio = results['w:"majority"'].avgMs / results["w:1"].avgMs;
  console.log(`  -> w:"majority" is ${ratio.toFixed(2)}x the latency of w:1 on average`);
  return { ...results, majorityToW1Ratio: +ratio.toFixed(2) };
}

// ---------------------------------------------------------------------------
async function partB() {
  console.log("\n===== PART B: degraded cluster (both secondaries down) =====");
  const { primary } = await waitForHealthy();
  const secondaries = MEMBERS.filter((h) => h !== primary);
  const log = [];
  const say = (msg) => {
    console.log(`  ${msg}`);
    log.push(msg);
  };
  say(`primary: ${short(primary)}; secondaries: ${secondaries.map(short).join(", ")}`);

  // Connect DIRECTLY to the primary so every write goes to that exact node.
  const direct = new MongoClient(`mongodb://${primary}/?directConnection=true`, {
    retryWrites: false,
    serverSelectionTimeoutMS: 3000,
  });
  await direct.connect();
  const col = direct.db(DB_NAME).collection(COLL);
  const runId = new ObjectId().toHexString();
  const out = { primary, secondaries, runId };

  try {
    // 1) take down both secondaries (crash)
    say(`docker kill ${secondaries.map(containerFor).join(" ")}  (simulate losing both secondaries)`);
    const tDown = performance.now();
    await Promise.all(secondaries.map((h) => killContainer(containerFor(h))));

    // 2) w:1 write
    let t = performance.now();
    try {
      const r = await col.insertOne({ runId, kind: "w1", note: "acknowledged by primary only" }, { writeConcern: { w: 1 } });
      out.w1 = { ok: true, ms: Math.round(performance.now() - t), insertedId: String(r.insertedId) };
      say(`w:1 insert           -> ACKNOWLEDGED in ${out.w1.ms} ms`);
    } catch (e) {
      out.w1 = { ok: false, ms: Math.round(performance.now() - t), error: `${e.name}: ${e.message}` };
      say(`w:1 insert           -> FAILED: ${e.message}`);
    }

    // 3) w:majority write with a timeout
    t = performance.now();
    try {
      await col.insertOne(
        { runId, kind: "majority", note: "needs 2 of 3 members" },
        { writeConcern: { w: "majority", wtimeoutMS: 3000 } }
      );
      out.majority = { ok: true, ms: Math.round(performance.now() - t) };
      say(`w:"majority" insert  -> acknowledged in ${out.majority.ms} ms (unexpected)`);
    } catch (e) {
      out.majority = {
        ok: false,
        ms: Math.round(performance.now() - t),
        errorName: e.name,
        code: e.code,
        codeName: e.codeName ?? e.result?.writeConcernError?.codeName,
        message: e.message,
        errInfo: e.errInfo ?? e.result?.writeConcernError?.errInfo,
      };
      say(`w:"majority" insert  -> ${e.name} after ${out.majority.ms} ms: code ${e.code} ${out.majority.codeName ?? ""} "${e.message}"`);
    }

    // 4) Are the docs on the primary? local vs majority read concern
    const local = await col.find({ runId }, { readConcern: { level: "local" } }).toArray();
    const majority = await col.find({ runId }, { readConcern: { level: "majority" } }).toArray();
    out.readsOnPrimary = {
      localSees: local.map((d) => d.kind),
      majoritySees: majority.map((d) => d.kind),
    };
    say(`read on primary, readConcern "local"   : sees [${out.readsOnPrimary.localSees.join(", ")}]`);
    say(`read on primary, readConcern "majority": sees [${out.readsOnPrimary.majoritySees.join(", ")}]`);
    say(`  -> the majority write FAILED from the client's view but IS stored on the primary (not majority-committed)`);

    // 5) wait for the primary to step down (it can't see a majority)
    let steppedDownMs = null;
    while (performance.now() - tDown < 30000) {
      const h = await hello(primary);
      if (h && !h.isWritablePrimary) {
        steppedDownMs = Math.round(performance.now() - tDown);
        break;
      }
      await sleep(200);
    }
    out.primaryStepDownMs = steppedDownMs;
    say(
      steppedDownMs
        ? `old primary stepped down to SECONDARY ${(steppedDownMs / 1000).toFixed(1)} s after losing the secondaries`
        : "old primary did not step down within 30 s"
    );

    // 6) try a w:1 write now - no primary means NO writes at all
    try {
      await col.insertOne({ runId, kind: "after-stepdown" }, { writeConcern: { w: 1 } });
      out.writeAfterStepDown = "accepted";
    } catch (e) {
      out.writeAfterStepDown = `${e.name}: ${e.message}`;
    }
    say(`w:1 insert after step-down -> ${out.writeAfterStepDown}`);
  } finally {
    await direct.close();
  }

  if (args["skip-rollback"]) {
    say("restarting secondaries (rollback demo skipped)");
    await Promise.all(secondaries.map((h) => startContainer(containerFor(h))));
    await waitForHealthy();
    return { ...out, log };
  }

  // ----------------------- rollback demonstration -----------------------
  console.log("\n  --- rollback demonstration ---");
  say(`docker kill ${containerFor(primary)} (old primary, holding the un-replicated writes)`);
  await killContainer(containerFor(primary));
  say(`docker start ${secondaries.map(containerFor).join(" ")}`);
  await Promise.all(secondaries.map((h) => startContainer(containerFor(h))));

  const t0 = performance.now();
  const np = await waitForNewPrimary(primary, t0, { timeoutMs: 90000 });
  out.newPrimary = np.host;
  say(`secondaries elected ${short(np.host)} as new primary (${(np.elapsedMs / 1000).toFixed(1)} s) - it never saw the w:1 / majority docs`);

  const rsClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  await rsClient.connect();
  try {
    const rcol = rsClient.db(DB_NAME).collection(COLL);
    await rcol.insertOne({ runId, kind: "new-primary-write" }, { writeConcern: { w: "majority" } });
    say(`wrote a new document on the new primary with w:"majority" (history has now diverged)`);

    say(`docker start ${containerFor(primary)} (old primary rejoins)`);
    await startContainer(containerFor(primary));
    await waitForHealthy();

    const after = await rcol.find({ runId }, { readConcern: { level: "majority" } }).toArray();
    out.afterRollback = after.map((d) => d.kind);
    const w1Survived = out.afterRollback.includes("w1");
    out.w1RolledBack = !w1Survived;
    say(`documents for this run after rejoin: [${out.afterRollback.join(", ")}]`);
    say(
      w1Survived
        ? "w:1 document SURVIVED (no rollback happened)"
        : "VERDICT: the w:1 write was ACKNOWLEDGED to the client but has been ROLLED BACK"
    );
  } finally {
    await rsClient.close();
  }

  // rollback files written by the old primary
  try {
    const files = await execInContainer(containerFor(primary), "sh", "-c", "find /data/db/rollback -type f 2>/dev/null");
    out.rollbackFiles = files.split("\n").filter(Boolean);
    say(`rollback files on ${containerFor(primary)}: ${out.rollbackFiles.length ? "" : "(none)"}`);
    out.rollbackFiles.forEach((f) => say(`    ${f}`));
    const mine = out.rollbackFiles.filter((f) => f.includes(`${DB_NAME}.${COLL}`) || f.includes("removed"));
    if (mine.length) {
      const dump = await execInContainer(
        containerFor(primary),
        "sh",
        "-c",
        `for f in ${mine.map((f) => `'${f}'`).join(" ")}; do bsondump --quiet "$f" 2>/dev/null; done | grep ${runId} || true`
      );
      out.rollbackFileContents = dump.split("\n").filter(Boolean);
      if (out.rollbackFileContents.length) {
        say("rolled-back documents saved in those files (bsondump):");
        out.rollbackFileContents.forEach((l) => say(`    ${l}`));
      }
    }
  } catch (e) {
    say(`could not inspect rollback files: ${e.message}`);
  }
  return { ...out, log };
}

// ---------------------------------------------------------------------------
async function main() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  await client.connect();
  try {
    const a = await partA(client);
    await client.close();
    const b = await partB();
    await waitForHealthy();
    await mkdir("results", { recursive: true });
    await writeFile(
      "results/write-concern.json",
      JSON.stringify({ ranAt: new Date().toISOString(), partA: a, partB: b }, null, 2)
    );
    console.log("\nSaved results/write-concern.json");
  } finally {
    await client.close().catch(() => {});
    await closeProbes();
  }
}

main().catch((err) => {
  console.error("Write concern experiment failed:", err);
  process.exitCode = 1;
});

