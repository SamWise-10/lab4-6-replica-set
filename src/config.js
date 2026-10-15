// Shared configuration for all lab scripts.

export const RS_NAME = "rs0";

export const HOST_IP = process.env.HOST_IP ?? "192.168.1.210";

// Replica set members exactly as registered in the replica set config.
export const MEMBERS = [
  `${HOST_IP}:27041`,
  `${HOST_IP}:27042`,
  `${HOST_IP}:27043`,
];

// Map replica-set member -> docker container name (used to stop/kill/start).
export const CONTAINERS = {
  [`${HOST_IP}:27041`]: "lab46-mongo1",
  [`${HOST_IP}:27042`]: "lab46-mongo2",
  [`${HOST_IP}:27043`]: "lab46-mongo3",
};

export const MONGO_URI =
  process.env.MONGO_URI ??
  `mongodb://${MEMBERS.join(",")}/?replicaSet=${RS_NAME}`;

export const DB_NAME = process.env.DB_NAME ?? "biodiversity";
export const SPECIES_COLLECTION = "species";

export const containerFor = (host) => {
  const c = CONTAINERS[host];
  if (!c) throw new Error(`No container mapped for member ${host}`);
  return c;
};
