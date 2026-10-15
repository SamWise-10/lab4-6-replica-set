# Lab 4 & 6: MongoDB Replica Set and Driver Integration

This repository contains the complete implementation, automated experimental test harnesses, and laboratory report for:
- **Lab 4:** Replica Set Deployment and Failover Analysis
- **Lab 6:** Write Concern Comparison and Node.js Driver Integration

---

## Quick Start

### 1. Prerequisites
- Docker Desktop running on Windows
- Node.js (v20+)

### 2. Start the 3-Member Replica Set
```powershell
docker compose up -d
```
This spins up three MongoDB 8.0 instances (`lab46-mongo1`, `lab46-mongo2`, `lab46-mongo3`) listening on ports `27041`, `27042`, and `27043`, and runs the one-shot `lab46-mongo-init` container to initiate `rs0`.

To verify health:
```powershell
npm run status
```
Output:
```text
Replica set: rs0   term: 1
  192.168.1.210:27041            PRIMARY    health=1
  192.168.1.210:27042            SECONDARY  health=1
  192.168.1.210:27043            SECONDARY  health=1
```

---

## Running the Lab Experiments

### Step 2: Election Timing & Failover Experiment
Measures failover times and winner election across 3 trials of `docker stop` (graceful) and 3 trials of `docker kill` (crash):
```powershell
npm run election
```
- Results table and summary printed to console.
- Data exported to `results/election.json`.

### Step 3: Write Concern Benchmark & Rollback Demonstration
Compares sequential latency of `w:1` vs `w:majority` over 200 writes, tests degraded cluster behavior when secondaries crash, and demonstrates automatic MongoDB data rollback:
```powershell
npm run writeconcern
```
- Results exported to `results/write-concern.json`.

---

## Step 4: Species CRUD CLI Application

### Run All CRUD Operations & Validation Checks
To see a full automated walkthrough showing every operation, validation rejection, and server `$jsonSchema` defense:
```powershell
npm run demo
```

### Run Unit Tests
To run the 33 unit tests for input validation (no database required):
```powershell
npm test
```

### Seed Realistic Species Data
Populates the `biodiversity.species` collection with 25 real wildlife species:
```powershell
npm run seed
```

### Manual CLI Usage
You can run any CRUD command manually using `node src/species.js`:

```powershell
# CREATE
node src/species.js create --commonName "Snow Leopard" --scientificName "Panthera uncia" --kingdom Animalia --status VU --population 4000 --habitats "mountains,alpine meadows"

# LIST / FILTER
node src/species.js list --status VU
node src/species.js list --kingdom Animalia --search "leopard"

# GET
node src/species.js get "Panthera uncia"

# UPDATE
node src/species.js update "Panthera uncia" --status EN --population 3500

# DELETE
node src/species.js delete "Panthera uncia"
```

---

## Project Structure
```text
├── docker-compose.yml        # 3 MongoDB 8.0 nodes (27041-27043) + init container
├── package.json              # npm scripts and mongodb driver dependency
├── REPORT.md                 # Complete, submittable lab report with empirical data
├── scripts/
│   └── init-replica.js       # Idempotent rs.initiate() script
├── src/
│   ├── config.js             # Replica set connection strings and container mappings
│   ├── status.js             # Quick cluster health and topology display
│   ├── seed.js               # Seed dataset (25 species) with upsert logic
│   ├── election-test.js      # Step 2 automated failover & timing test harness
│   ├── write-concern-test.js # Step 3 latency benchmark & rollback experiment
│   ├── species.js            # Step 4 interactive CLI
│   ├── species/
│   │   ├── validation.js     # App-level validation, normalization, and regex escaping
│   │   ├── schema.js         # MongoDB collection-level $jsonSchema validator & indexes
│   │   └── repository.js     # Data access layer with w:"majority" writes
│   └── lib/
│       ├── docker.js         # Safe child_process wrapper for container management
│       └── rs.js             # Direct-connection cluster probing and election detection
├── test/
│   └── validation.test.js    # 33 unit tests for validation rules
└── results/
    ├── election.json         # Raw metrics from election timing trials
    └── write-concern.json    # Latency percentiles and rollback dump data
```

