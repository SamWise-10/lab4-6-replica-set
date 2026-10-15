// Lab 4 & 6 - Replica set initiation (run with mongosh against any member).
// Idempotent: if the replica set is already initiated it just prints status.

const RS_NAME = "rs0";
const HOST_IP = "192.168.1.210";
const MEMBERS = [
  { _id: 0, host: `${HOST_IP}:27041` },
  { _id: 1, host: `${HOST_IP}:27042` },
  { _id: 2, host: `${HOST_IP}:27043` },
];

function alreadyInitiated() {
  try {
    rs.status();
    return true;
  } catch (e) {
    // 94 = NotYetInitialized
    if (e.code === 94 || /no replset config/i.test(e.message)) return false;
    throw e;
  }
}

if (alreadyInitiated()) {
  print(`Replica set '${RS_NAME}' already initiated.`);
} else {
  print(`Initiating replica set '${RS_NAME}'...`);
  // Equal priorities (default 1) and default electionTimeoutMillis (10000 ms)
  // so the election experiment measures MongoDB's real default behaviour.
  const res = rs.initiate({ _id: RS_NAME, members: MEMBERS });
  printjson(res);
}

// Wait (max ~60 s) until a PRIMARY has been elected.
let primary = null;
for (let i = 0; i < 120 && !primary; i++) {
  try {
    const st = rs.status();
    const p = st.members.find((m) => m.stateStr === "PRIMARY");
    if (p) primary = p.name;
  } catch (e) {
    /* still starting */
  }
  if (!primary) sleep(500);
}

if (!primary) {
  print("ERROR: no PRIMARY elected within 60 s");
  quit(1);
}

print(`PRIMARY: ${primary}`);
rs.status().members.forEach((m) => print(`  ${m.name.padEnd(30)} ${m.stateStr}`));
