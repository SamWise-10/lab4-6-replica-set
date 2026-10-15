// Replica-set helpers: talk to each member *directly* so we can observe
// per-node state (who is primary) even while the set is failing over.
import { MongoClient } from "mongodb";
import { MEMBERS } from "../config.js";

const probes = new Map();

function probeClient(host) {
  if (!probes.has(host)) {
    probes.set(
      host,
      new MongoClient(`mongodb://${host}/?directConnection=true`, {
        serverSelectionTimeoutMS: 700,
        connectTimeoutMS: 700,
        socketTimeoutMS: 2000,
        heartbeatFrequencyMS: 500,
      })
    );
  }
  return probes.get(host);
}

export async function closeProbes() {
  await Promise.all([...probes.values()].map((c) => c.close().catch(() => {})));
  probes.clear();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `hello` on one member. Returns null if unreachable. */
export async function hello(host) {
  try {
    return await probeClient(host).db("admin").command({ hello: 1 });
  } catch {
    return null;
  }
}

/** Ask every member who is primary; returns the host name or null. */
export async function getPrimary(members = MEMBERS) {
  const results = await Promise.all(members.map(async (h) => [h, await hello(h)]));
  const p = results.find(([, r]) => r?.isWritablePrimary);
  return p ? p[0] : null;
}

/** replSetGetStatus from a specific member (or null). */
export async function rsStatus(host) {
  try {
    return await probeClient(host).db("admin").command({ replSetGetStatus: 1 });
  } catch {
    return null;
  }
}

/** replSetGetStatus from the first reachable member. */
export async function anyRsStatus(members = MEMBERS) {
  for (const h of members) {
    const s = await rsStatus(h);
    if (s) return s;
  }
  return null;
}

/**
 * Poll every `pollMs` until a member other than `excludeHost` reports
 * isWritablePrimary. `t0` is the high-resolution start time (performance.now()).
 */
export async function waitForNewPrimary(excludeHost, t0, { pollMs = 100, timeoutMs = 60000 } = {}) {
  const candidates = MEMBERS.filter((h) => h !== excludeHost);
  while (performance.now() - t0 < timeoutMs) {
    const results = await Promise.all(candidates.map(async (h) => [h, await hello(h)]));
    const winner = results.find(([, r]) => r?.isWritablePrimary);
    if (winner) {
      return { host: winner[0], elapsedMs: performance.now() - t0, hello: winner[1] };
    }
    await sleep(pollMs);
  }
  throw new Error(`No new primary within ${timeoutMs} ms`);
}

/**
 * Wait until the set is fully healthy: 1 PRIMARY + 2 SECONDARY, all
 * secondaries caught up to the primary's optime.
 */
export async function waitForHealthy({ timeoutMs = 120000, quiet = false } = {}) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const st = await anyRsStatus();
    if (st) {
      const states = st.members.map((m) => m.stateStr);
      const primary = st.members.find((m) => m.stateStr === "PRIMARY");
      const secondaries = st.members.filter((m) => m.stateStr === "SECONDARY" && m.health === 1);
      const summary = st.members.map((m) => `${m.name.split(":")[1]}=${m.stateStr}`).join(" ");
      if (!quiet && summary !== last) {
        console.log(`    [rs] ${summary}`);
        last = summary;
      }
      if (
        primary &&
        secondaries.length === 2 &&
        states.length === 3 &&
        secondaries.every((s) => s.optimeDate?.getTime() === primary.optimeDate?.getTime())
      ) {
        return { primary: primary.name, term: st.term };
      }
    }
    await sleep(500);
  }
  throw new Error("Replica set did not become healthy in time");
}

export function printMembers(st) {
  for (const m of st.members) {
    console.log(`  ${m.name.padEnd(30)} ${m.stateStr.padEnd(10)} health=${m.health}`);
  }
}

