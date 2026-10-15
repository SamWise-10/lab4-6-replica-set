# Lab Report: MongoDB Replica Set & Driver Integration
**Course / Lab:** Lab 4 & Lab 6 — Replica Set and Driver Integration  
**Date:** October 14, 2026  
**Environment:** Docker Desktop (Engine 29.7.2, Compose v5.5.0), Node.js v24.13.1, MongoDB 8.0 (`mongo:8.0`), `mongodb` Node driver v6.12.0  

---

## Executive Summary

This laboratory exercise covers two core distributed database topics:
1. **Replica Set High Availability and Consensus (Lab 4):** Deploying a 3-member MongoDB replica set, measuring failover duration during primary failure, and observing member states and term changes.
2. **Write Concerns & Driver Integration (Lab 6):** Analyzing latency and durability trade-offs between `w: 1` and `w: 'majority'`, observing replica set degradation, demonstrating data rollback on un-majority-committed writes, and implementing an application-level CRUD driver with dual-layer validation.

All benchmarks and failover trials recorded below were executed against live containers on this machine.

---

## 1. Replica Set Architecture & Startup

A three-member replica set (`rs0`) was deployed using Docker Compose with MongoDB 8.0:
- **`lab46-mongo1`**: Port `27041`, priority 1.0, votes 1
- **`lab46-mongo2`**: Port `27042`, priority 1.0, votes 1
- **`lab46-mongo3`**: Port `27043`, priority 1.0, votes 1

### Member Status (`rs.status()`)
```json
{
  "set": "rs0",
  "term": 1,
  "members": [
    { "name": "192.168.1.210:27041", "stateStr": "PRIMARY",   "health": 1 },
    { "name": "192.168.1.210:27042", "stateStr": "SECONDARY", "health": 1 },
    { "name": "192.168.1.210:27043", "stateStr": "SECONDARY", "health": 1 }
  ]
}
```

> **Networking Design Note:** Each node exposes an independent host port. The replica set members are registered using the host interface IP (`192.168.1.210:<port>`), enabling the Node.js MongoDB driver on the host operating system to discover all replica set members, perform automatic topology updates, and fail over seamlessly.

---

## 2. Primary Failover & Election Timing (Step 2)

### Methodology
To record accurate election latency and winner selection:
- An automated harness (`src/election-test.js`) inserted a marker document (`failover_markers`) with `{ w: "majority" }` prior to every trial to guarantee data presence.
- The active primary was identified and stopped.
- High-resolution timing (`performance.now()`) tracked the exact time elapsed until another member reported `isWritablePrimary: true` (polled every 100 ms via direct probe).
- Two distinct failure modes were tested (3 trials each, 6 trials total):
  1. **Graceful Step-down (`docker stop` / SIGTERM):** The primary process receives a termination signal, voluntarily steps down, and initiates an immediate handoff to an up-to-date secondary.
  2. **Crash / Hard Failure (`docker kill` / SIGKILL):** The primary terminates abruptly without sending notice. Secondaries must wait for missed heartbeats before calling an election.

### Empirical Results

| Failure Mode | Trial | Old Primary | Winner (New Primary) | Failover Time | Term Transition | Election Reason | Data Loss? |
| :--- | :---: | :--- | :--- | :---: | :---: | :--- | :---: |
| **`docker stop`** | 1 | `lab46-mongo1` (:27041) | `lab46-mongo2` (:27042) | **0.50 s** | 1 &rarr; 2 | `stepUpRequestSkipDryRun` | None (0) |
| **`docker stop`** | 2 | `lab46-mongo2` (:27042) | `lab46-mongo1` (:27041) | **0.38 s** | 2 &rarr; 3 | `stepUpRequestSkipDryRun` | None (0) |
| **`docker stop`** | 3 | `lab46-mongo1` (:27041) | `lab46-mongo3` (:27043) | **0.35 s** | 3 &rarr; 4 | `stepUpRequestSkipDryRun` | None (0) |
| **`docker kill`** | 1 | `lab46-mongo3` (:27043) | `lab46-mongo2` (:27042) | **11.87 s** | 4 &rarr; 5 | `electionTimeout` | None (0) |
| **`docker kill`** | 2 | `lab46-mongo2` (:27042) | `lab46-mongo1` (:27041) | **14.45 s** | 5 &rarr; 6 | `electionTimeout` | None (0) |
| **`docker kill`** | 3 | `lab46-mongo1` (:27041) | `lab46-mongo3` (:27043) | **13.60 s** | 6 &rarr; 7 | `electionTimeout` | None (0) |

### Summary Comparison
- **Graceful Shutdown (`docker stop`):** Average **0.41 seconds** (Min: 0.35 s, Max: 0.50 s).
- **Crash Simulation (`docker kill`):** Average **13.31 seconds** (Min: 11.87 s, Max: 14.45 s).
- **Data Integrity:** 100% of inserted markers and all 25 seeded species survived across all 6 trials. When the stopped container restarted, it rejoined the cluster as `SECONDARY` and synchronized via replication oplog.

### Analytical Observations
1. **Why `docker stop` is fast (~0.4s):** When receiving SIGTERM, `mongod` invokes `replSetStepDown`. It quiesces writes, pushes uncommitted oplog entries, selects an eligible secondary, and signals it to run `stepUpRequestSkipDryRun`. The election occurs immediately without waiting for a timeout.
2. **Why `docker kill` takes ~13s:** During a crash, secondaries receive no notification. MongoDB's default `electionTimeoutMillis` is **10,000 ms (10 seconds)** with a heartbeat interval of 2,000 ms. Secondaries must observe consecutive missed heartbeats (10s), add a randomized election jitter, and run a Raft-style dry-run election before declaring a new leader.
3. **Term Monotonicity:** Every election increments the term counter by exactly 1 (`1 -> 2 -> ... -> 7`).

---

## 3. Write Concern Comparison (`w: 1` vs `w: "majority"`) (Step 3)

### Part A: Latency on a Healthy Cluster (200 Sequential Writes Each)
In a healthy 3-member cluster, writes were benchmarked sequentially to measure synchronization overhead.

| Metric | `w: 1` (Primary Only) | `w: "majority"` (Primary + 1 Secondary) | Difference / Overhead |
| :--- | :---: | :---: | :---: |
| **Average Latency** | **10.32 ms** | **48.40 ms** | **4.69&times; slower** |
| **Median (p50)** | 7.97 ms | 35.53 ms | 4.46&times; slower |
| **95th Percentile (p95)** | 24.09 ms | 134.35 ms | 5.58&times; slower |
| **Maximum** | 60.18 ms | 415.11 ms | 6.90&times; slower |
| **Total Runtime (200 ops)**| 2,064.9 ms | 9,679.1 ms | +7.61 seconds |

#### Explanation of Latency Difference
- With **`w: 1`**, the primary acknowledges the client as soon as the write is applied to its local memory/WiredTiger journal buffer. It does **not** wait for network transmission to other nodes.
- With **`w: "majority"`**, in a 3-node set, majority is $\lceil (3+1)/2 \rceil = 2$ nodes. The primary must push oplog entries over the network to at least 1 secondary, wait for that secondary to flush/acknowledge the oplog entry, and only then return an acknowledgment to the client. This network round-trip and multi-node sync introduces the measured ~4.7&times; latency overhead.

---

### Part B: Degraded Cluster & Rollback Demonstration

To demonstrate durability semantics, both secondaries (`lab46-mongo1` and `lab46-mongo2`) were abruptly stopped (`docker kill`), leaving only `lab46-mongo3` running alone.

```
+-------------------------------------------------------------------------+
|                  Degraded Cluster Failure Sequence                      |
|                                                                         |
|  1. Kill both secondaries -> Only Primary (lab46-mongo3) is alive       |
|  2. Execute Write A with { w: 1 }            -> SUCCEEDS in 43 ms       |
|  3. Execute Write B with { w: 'majority' }   -> FAILS after 3,055 ms    |
|     (MongoWriteConcernError: "waiting for replication timed out")        |
|  4. Query with readConcern "local"           -> Sees [A, B]             |
|  5. Query with readConcern "majority"        -> Sees []                 |
|  6. 10.1s later: Primary steps down          -> "not primary" error     |
|  7. Kill old primary, restart secondaries    -> Elect new primary       |
|  8. Insert Write C on new primary            -> Diverges history        |
|  9. Restart old primary                      -> State = ROLLBACK        |
| 10. Final check: Document A (w:1) is GONE (ROLLED BACK to disk)         |
+-------------------------------------------------------------------------+
```

#### Detailed Findings
1. **Immediate Write Behavior:**
   - **`w: 1` write:** Acknowledged in **43 ms** with status `OK`. The primary accepted the document locally even though it was completely isolated from the rest of the cluster.
   - **`w: "majority"` write:** Blocked until `wtimeoutMS: 3000` expired, throwing `MongoWriteConcernError` (Code 64 `WriteConcernFailed: "waiting for replication timed out"`).
2. **Client Error vs Server Storage:**
   - Querying the primary with `{ readConcern: { level: "local" } }` returned **both documents** (`[w1, majority]`).
   - Querying with `{ readConcern: { level: "majority" } }` returned **empty** (`[]`).
   - *Key takeaway:* A `wtimeout` error does **not** mean the write was canceled; the document was committed to the primary's local database, but failed majority durability.
3. **Primary Step-Down:**
   - Exactly **10.1 seconds** after losing its secondaries, `lab46-mongo3` realized it could no longer reach a majority of voting members.
   - It demoted itself to `SECONDARY`. Subsequent writes threw `MongoServerError: not primary`.
4. **The Rollback Phenomenon:**
   - When the two original secondaries were powered on, they held a majority (2 out of 3 votes) and elected a new primary (`lab46-mongo1`). Neither secondary had ever received Write A (`w: 1`) or Write B.
   - A new write was committed on the new primary, diverging the oplog history.
   - When the old primary (`lab46-mongo3`) was restarted, its oplog diverged from the majority.
   - The replica set coordinator transitioned `lab46-mongo3` through state `ROLLBACK`:
     ```
     [rs] 27041=PRIMARY 27042=SECONDARY 27043=ROLLBACK
     [rs] 27041=PRIMARY 27042=SECONDARY 27043=SECONDARY
     ```
   - **Result:** Document A (acknowledged with `w: 1`) was **permanently rolled back and removed** from the active database!
   - MongoDB saved the rolled-back document to disk in a BSON rollback file:
     `/data/db/rollback/d7bc6ee2-6f1c-4f2b-9f73-938b9331f6f1/removed.2026-10-14T10-15-28.0.bson`
   - Inspecting this file with `bsondump` confirmed the exact recovered documents:
     ```json
     {"_id":{"$oid":"6acf561d805c343badd49512"},"runId":"6acf561b805c343badd49511","kind":"w1","note":"acknowledged by primary only"}
     {"_id":{"$oid":"6acf561d805c343badd49513"},"runId":"6acf561b805c343badd49511","kind":"majority","note":"needs 2 of 3 members"}
     ```

---

## 4. Species CRUD Driver & Validation Integration (Step 4)

A complete Node.js application was built in `src/` to manage wildlife species records on the `biodiversity` database.

### Data Model & Validation Rules
| Field | Type / Rule | Error Handling |
| :--- | :--- | :--- |
| `_id` | MongoDB `ObjectId` | Auto-generated |
| `commonName` | String, 2–100 chars, letters/hyphens/spaces | Required |
| `scientificName` | String, regex `^[A-Z][a-z]+ [a-z]+(?: [a-z]+)?$` | Required, Unique Index |
| `kingdom` | Enum: `Animalia`, `Plantae`, `Fungi`, etc. | Case-normalized |
| `conservationStatus` | Enum IUCN Red List: `LC`, `NT`, `VU`, `EN`, `CR`, `EW`, `EX`, `DD`, `NE` | Uppercased |
| `population` | Integer &ge; 0 | Optional, rejects negatives/floats |
| `habitats` | Array of strings, 2–50 chars each, max 20 | Deduplicated, trimmed |
| `createdAt` / `updatedAt` | BSON Date | System-managed, immutable |

### Dual-Layer Validation Defense
1. **Application-Level (`src/species/validation.js`):** Collects all validation errors across all fields in a single pass (rather than failing on the first error) and cleans inputs before sending queries.
2. **Server-Level (`src/species/schema.js`):** Enforces a strict MongoDB `$jsonSchema` collection validator. Even if malicious clients bypass Node.js validation, MongoDB rejects the document with error `121 (Document failed validation)`.

### Unit Test Verification (`npm test`)
33 tests executed via Node's native test runner (`node:test`):
```text
✔ create: accepts a valid species
✔ create: normalizes whitespace, enum case and habitats
✔ create: population and habitats are optional
✔ create: reports every missing required field
✔ create: collects ALL errors at once
✔ create: rejects scientificName invalid formats
✔ create: accepts trinomial (subspecies) scientific names
✔ create: rejects population invalid values
✔ create: rejects commonName with digits or symbols
✔ create: rejects invalid habitats entries
✔ create: rejects unknown and immutable fields
✔ update: accepts a partial patch
✔ update: rejects an empty patch
✔ update: rejects blanking a required field
✔ update: empty population unsets it; empty habitats clears the list
✔ identifier: accepts an ObjectId or scientific name
✔ identifier: rejects garbage and injection attempts
✔ list: builds filters and escapes regex metacharacters in search
ℹ tests 33, pass 33, fail 0 (duration: 782ms)
```

### CLI Operations (`npm run demo` Live Execution Output)
```text
▶ CREATE a valid species (Snow Leopard)
✔ Created: Snow Leopard (Panthera uncia) [6acf558b6ae4411f77df2d5b] - Status: VU, Population: 4000

▶ CREATE duplicate scientificName (should fail: unique index)
✘ Rejected by app validation:
    - scientificName: a species named "Panthera uncia" already exists

▶ CREATE with many invalid fields (should fail: app validation lists ALL errors)
✘ Rejected by app validation:
    - color: unknown field
    - commonName: must be 2-100 characters (got 1)
    - scientificName: must look like "Genus species" (got "panthera Uncia")
    - kingdom: must be one of Animalia, Plantae... (got "Dinosauria")
    - conservationStatus: must be an IUCN code (got "SAFE")
    - population: must be >= 0 (got -5)

▶ BYPASS app validation: raw insertOne of a bad document (should fail: $jsonSchema, code 121)
✘ Rejected by MongoDB server: code 121 (Document failed validation)
    - rule 'properties' failed for: scientificName, kingdom, population

▶ UPDATE: Snow Leopard status VU -> EN, population 4000 -> 3500
✔ Updated: status changed to EN (Endangered), population updated to 3500

▶ DELETE Venus Flytrap
✔ Deleted Venus Flytrap (Dionaea muscipula)
```

---

## 5. Conclusions & Key Takeaways

1. **Election Speed Depends on Failure Mode:**
   A graceful shutdown allows the primary to hand off authority in **~0.4 seconds**, whereas an unannounced crash leaves secondaries waiting for `electionTimeoutMillis` (**~13.3 seconds**).
2. **Durability Requires `w: 'majority'`:**
   `w: 1` acknowledges writes that exist only in a single node's volatile state. If that node isolates and fails before replicating, those writes will be **silently rolled back** when a new primary is elected by the majority.
3. **Write Timeouts Do Not Roll Back Writes Automatically:**
   A `wtimeout` error on `w: 'majority'` signals that replication did not reach a majority in time, but the primary **still committed the document locally**. Client applications must handle write concern errors with compensating transactions or idempotency keys.
4. **Defense in Depth for Data Modeling:**
   Validating at the application layer provides clear, helpful user feedback, while server-side `$jsonSchema` prevents invalid data from entering the database through alternate tools or compromised scripts.

