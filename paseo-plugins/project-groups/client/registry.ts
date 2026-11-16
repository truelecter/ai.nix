// One entry per connected host that runs this plugin. Paseo evaluates the client entry once per
// host, but renders the sidebar view once, under one host's installation, whose RPCs reach only
// that host. Every installation therefore publishes its host's group document here, on a
// plugin-owned global, and the view reads all of them. An installation removes its entry when it
// stops; the global goes away with the last entry and the last listener.

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { settingsRpc } from "@getpaseo/plugin";
import { useSyncExternalStore } from "react";
import { emptyGroupDoc, groupChanges, groupSettings, type GroupDoc } from "../shared/settings.ts";
import type { DocChange, HostProjects } from "./assignments.ts";
import { createDocumentSync, type DocumentStatus } from "./sync.ts";

export interface HostGroups extends HostProjects {
  readonly status: DocumentStatus;
  update(change: DocChange): Promise<void>;
  /** Re-reads the document and this host's project listing. */
  refresh(): Promise<void>;
}

interface Registry {
  readonly entries: Map<object, HostGroups>;
  readonly listeners: Set<() => void>;
  snapshot: readonly HostGroups[];
}

// Bump the version when `HostGroups` changes shape, so bundles of different versions (one host
// updated before another) never read each other's entries.
const REGISTRY = Symbol.for("paseo-plugin:project-groups:hosts:v1");

// The slot holds only what this module stores there, under its own versioned symbol.
const holder = globalThis as typeof globalThis & { [REGISTRY]?: Registry };

function registry(): Registry {
  const existing = holder[REGISTRY];
  if (existing) return existing;
  const created: Registry = { entries: new Map(), listeners: new Set(), snapshot: [] };
  holder[REGISTRY] = created;
  return created;
}

function publish(store: Registry) {
  // The newest installation of a host wins, then hosts sort by ID so the fallback host is stable.
  const byHost = new Map<string, HostGroups>();
  for (const entry of store.entries.values()) byHost.set(entry.hostId, entry);
  store.snapshot = Object.freeze(
    Array.from(byHost.values()).sort((a, b) => a.hostId.localeCompare(b.hostId)),
  );
  for (const listener of store.listeners) listener();
}

function release(store: Registry) {
  if (holder[REGISTRY] === store && store.entries.size === 0 && store.listeners.size === 0)
    delete holder[REGISTRY];
}

function subscribe(listener: () => void): () => void {
  const store = registry();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
    release(store);
  };
}

function snapshot(): readonly HostGroups[] {
  return holder[REGISTRY]?.snapshot ?? EMPTY;
}

const EMPTY: readonly HostGroups[] = Object.freeze([]);

/** Every connected host's group document, sorted by host ID. */
export function useHostGroups(): readonly HostGroups[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Publishes this installation's host. Returns the installation's cleanup. */
export function startHostGroups(client: PluginClientContext): () => void {
  const rpc = settingsRpc(groupSettings.id);
  const lifetime = new AbortController();
  const token = {};
  let hostId: string | null = null;
  let projectKeys: Record<string, string | null> | null = null;

  const warn = (what: string, error: unknown) => {
    if (!lifetime.signal.aborted) console.warn(`[project-groups] ${what}`, error);
  };

  const sync = createDocumentSync<GroupDoc>({
    read: () => client.rpc(rpc.read, {}),
    write: (revision, values) => client.rpc(rpc.write, { revision, values }),
    parse: (values) => groupSettings.schema.parse(values),
    empty: emptyGroupDoc,
    onChange: () => update(),
    onError: (error) => warn("Could not sync groups", error),
  });

  async function refresh() {
    await Promise.all([
      sync.refresh(),
      client.paseo.projects.list().then(
        ({ projects }) => {
          projectKeys = Object.fromEntries(
            projects.map((project) => [project.projectId, project.projectKey ?? null]),
          );
        },
        (error: unknown) => warn("Could not list projects", error),
      ),
    ]);
    update();
  }

  function update() {
    if (lifetime.signal.aborted || hostId === null) return;
    const store = registry();
    store.entries.set(token, {
      hostId,
      doc: sync.current(),
      status: sync.status(),
      projectKeys,
      update: sync.update,
      refresh,
    });
    publish(store);
  }

  void client.paseo.hosts
    .list()
    .then(({ self }) => {
      if (lifetime.signal.aborted) return;
      hostId = self.serverId;
      // The daemon pushes on subscribe and after each saved change, from any client.
      client.subscribe(groupChanges, {}, () => void refresh(), {
        signal: lifetime.signal,
        onClosed: ({ error }) => {
          if (error) warn("Group change feed closed", error);
        },
      });
      return refresh();
    })
    .catch((error: unknown) => warn("Could not identify this host", error));

  return () => {
    lifetime.abort();
    const store = holder[REGISTRY];
    if (!store?.entries.delete(token)) return;
    publish(store);
    release(store);
  };
}
