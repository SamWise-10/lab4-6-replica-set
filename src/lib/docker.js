// Thin wrapper around the docker CLI. Uses execFile (no shell), so the
// '&' in the project folder name can never be interpreted by a shell.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function docker(...args) {
  const { stdout } = await run("docker", args, { windowsHide: true });
  return stdout.trim();
}

/** Graceful shutdown: SIGTERM, mongod steps down / shuts down cleanly. */
export const stopContainer = (name) => docker("stop", name);

/** Crash simulation: SIGKILL, no chance to step down. */
export const killContainer = (name) => docker("kill", name);

export const startContainer = (name) => docker("start", name);

export const execInContainer = (name, ...cmd) => docker("exec", name, ...cmd);

export async function isRunning(name) {
  const out = await docker("inspect", "-f", "{{.State.Running}}", name);
  return out === "true";
}

