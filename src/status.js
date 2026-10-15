// Prints the current replica set status (who is PRIMARY / SECONDARY).
import { anyRsStatus, closeProbes, printMembers } from "./lib/rs.js";

const st = await anyRsStatus();
if (!st) {
  console.error("No replica set member reachable. Is `docker compose up -d` running?");
  process.exitCode = 3;
} else {
  console.log(`Replica set: ${st.set}   term: ${st.term}`);
  printMembers(st);
}
await closeProbes();

