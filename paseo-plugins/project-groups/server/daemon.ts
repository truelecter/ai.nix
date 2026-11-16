// Daemon requests the plugin SDK has no call for. The plugin process connects to its own daemon
// the way Paseo's CLI does: the address from `<home>/paseo.pid`, the token from
// `<home>/local-credential`, both written by the running daemon. One connection serves every
// request and is opened again when it drops (a daemon restart changes nothing here).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostClient } from "@getpaseo/client/node";

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function resolvePaseoHome(env: NodeJS.ProcessEnv): string {
  const home = env.PASEO_HOME?.trim();
  return home ? expandHome(home) : path.join(homedir(), ".paseo");
}

/** The daemon's listen address from its pid file. */
export function parseListen(pidFile: string): string {
  const value: unknown = JSON.parse(pidFile);
  const listen =
    value && typeof value === "object" && "listen" in value ? value.listen : undefined;
  if (typeof listen !== "string" || listen.trim() === "")
    throw new Error("The daemon's pid file has no listen address");
  return listen.trim();
}

async function readText(file: string, what: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Can't read the daemon's ${what} (${file})`, { cause: error });
  }
}

export interface DaemonConnection {
  use<T>(work: (client: DaemonClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDaemonConnection(env: NodeJS.ProcessEnv = process.env): DaemonConnection {
  let pending: Promise<DaemonClient> | null = null;

  async function open(): Promise<DaemonClient> {
    const home = resolvePaseoHome(env);
    const listen = parseListen(await readText(path.join(home, "paseo.pid"), "pid file"));
    const token = (await readText(path.join(home, "local-credential"), "local credential")).trim();
    const client = createHostClient(listen, {
      clientId: `plugin-project-groups-${randomUUID()}`,
      clientType: "cli",
      localCredential: () => token || undefined,
      connectTimeoutMs: 10_000,
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async function connected(): Promise<DaemonClient> {
    const current = pending ? await pending.catch(() => null) : null;
    if (current?.getConnectionState().status === "connected") return current;
    void current?.close().catch(() => undefined);
    const next = open();
    pending = next;
    next.catch(() => {
      if (pending === next) pending = null;
    });
    return next;
  }

  return {
    async use(work) {
      return work(await connected());
    },
    async close() {
      const current = pending;
      pending = null;
      await (await current?.catch(() => null))?.close().catch(() => undefined);
    },
  };
}
