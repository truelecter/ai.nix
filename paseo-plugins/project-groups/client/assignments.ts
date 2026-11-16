// Pure model of where a project's group assignment lives across hosts, and how Paseo 0.15
// assignments move to it. No React or SDK runtime here, so it runs under `bun test`.
//
// Each host that runs this plugin keeps a document in its own host settings:
// - `projects`: this host's projects, by project ID.
// - `remote`: projects of hosts that don't run the plugin, by cross-host ref key.
// - `legacy`: Paseo 0.15 assignments, keyed by the old sidebar's project view key.

import type { GroupDoc } from "../shared/settings.ts";

export interface HostDoc {
  readonly hostId: string;
  readonly doc: GroupDoc;
}

export interface HostProjects extends HostDoc {
  /** This host's projects (project ID -> shared project key), or null before the first listing. */
  readonly projectKeys: Readonly<Record<string, string | null>> | null;
}

export interface ProjectLocation {
  readonly hostId: string;
  readonly projectId: string;
}

export type DocChange = (doc: GroupDoc) => GroupDoc;

/**
 * The SDK's cross-host ref key for a project. Paseo 0.15 used the same string as the view key of
 * a project it could not match across hosts.
 */
export function projectRefKey(hostId: string, projectId: string): string {
  return JSON.stringify([hostId, projectId]);
}

export type LegacyKey =
  | { kind: "placement"; hostId: string; projectId: string; exact: boolean }
  | { kind: "equivalence"; projectKey: string };

/**
 * Paseo 0.15 view keys: the shared project key when it was unique on its host, else
 * `JSON.stringify([serverId, projectId])`, or `["placement", serverId, projectId, n]` on a clash.
 */
export function parseLegacyKey(key: string): LegacyKey {
  if (key.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(key);
      if (Array.isArray(value)) {
        if (value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string")
          return { kind: "placement", hostId: value[0], projectId: value[1], exact: true };
        if (
          value.length === 4 &&
          value[0] === "placement" &&
          typeof value[1] === "string" &&
          typeof value[2] === "string"
        )
          return { kind: "placement", hostId: value[1], projectId: value[2], exact: false };
      }
    } catch {
      // Not JSON: a project key that happens to start with a bracket.
    }
  }
  return { kind: "equivalence", projectKey: key };
}

/**
 * Group path by project ref key, for the projects given. The owning host's own entry wins, then an
 * entry another host keeps for it (`remote`, or a 0.15 placement key not migrated yet).
 */
export function effectiveAssignments(
  docs: readonly HostDoc[],
  projects: readonly ProjectLocation[],
): Record<string, string> {
  const byHost = new Map(docs.map((entry) => [entry.hostId, entry.doc]));
  const result: Record<string, string> = {};
  for (const project of projects) {
    const key = projectRefKey(project.hostId, project.projectId);
    const owner = byHost.get(project.hostId);
    if (owner && Object.hasOwn(owner.projects, project.projectId)) {
      result[key] = owner.projects[project.projectId];
      continue;
    }
    const remote = docs.find((entry) => Object.hasOwn(entry.doc.remote, key));
    if (remote) {
      result[key] = remote.doc.remote[key];
      continue;
    }
    const legacy = docs.find((entry) => Object.hasOwn(entry.doc.legacy, key));
    if (legacy) result[key] = legacy.doc.legacy[key];
  }
  return result;
}

export interface AssignmentWrite extends ProjectLocation {
  /** Undefined removes the assignment, so the project's name decides again. */
  readonly path: string | undefined;
}

interface DocEdit {
  projects: Map<string, string | undefined>;
  remote: Map<string, string | undefined>;
  dropLegacy: Set<string>;
  applied: Set<string>;
}

function applyEdit(doc: GroupDoc, edit: DocEdit): GroupDoc {
  const projects = { ...doc.projects };
  for (const [id, path] of edit.projects) {
    if (path === undefined) delete projects[id];
    else projects[id] = path;
  }
  const remote = { ...doc.remote };
  for (const [key, path] of edit.remote) {
    if (path === undefined) delete remote[key];
    else remote[key] = path;
  }
  const legacy = { ...doc.legacy };
  for (const key of edit.dropLegacy) delete legacy[key];
  const appliedLegacy = [...new Set([...doc.appliedLegacy, ...edit.applied])];
  return { projects, remote, legacy, appliedLegacy };
}

function editsFor(edits: Map<string, DocEdit>, hostId: string): DocEdit {
  let edit = edits.get(hostId);
  if (!edit) {
    edit = { projects: new Map(), remote: new Map(), dropLegacy: new Set(), applied: new Set() };
    edits.set(hostId, edit);
  }
  return edit;
}

function toChanges(edits: Map<string, DocEdit>): Map<string, DocChange> {
  return new Map(
    Array.from(edits, ([hostId, edit]) => [hostId, (doc: GroupDoc) => applyEdit(doc, edit)]),
  );
}

/**
 * Which host documents change, and how, to store `writes`. A project's assignment goes to its own
 * host when that host runs the plugin, else to `remote` of the first document. Copies other hosts
 * keep for the same project are removed, so they can't come back when the new value is removed.
 */
export function planWrites(
  docs: readonly HostDoc[],
  writes: readonly AssignmentWrite[],
): Map<string, DocChange> {
  const fallback = docs[0];
  if (!fallback) throw new Error("No connected host runs project-groups");
  const edits = new Map<string, DocEdit>();
  for (const write of writes) {
    const key = projectRefKey(write.hostId, write.projectId);
    const owned = docs.some((entry) => entry.hostId === write.hostId);
    if (owned) editsFor(edits, write.hostId).projects.set(write.projectId, write.path);
    else editsFor(edits, fallback.hostId).remote.set(key, write.path);
    for (const entry of docs) {
      const keepsRemote = !owned && entry.hostId === fallback.hostId;
      if (!keepsRemote && Object.hasOwn(entry.doc.remote, key))
        editsFor(edits, entry.hostId).remote.set(key, undefined);
      if (Object.hasOwn(entry.doc.legacy, key)) editsFor(edits, entry.hostId).dropLegacy.add(key);
    }
  }
  return toChanges(edits);
}

export interface MigrationPlan {
  /** Adds the migrated assignments; never replaces an assignment the target already has. */
  readonly writes: Map<string, DocChange>;
  /** Removes the migrated placement keys. Apply after every write has been saved. */
  readonly drops: Map<string, DocChange>;
}

/**
 * Copies Paseo 0.15 assignments to the projects they name, using each host's project listing.
 *
 * A placement key names one project: once its host is listed, it is copied there and removed. A
 * shared project key applies to the project with that key on each listed host where it is the
 * only one (as 0.15 matched it). It is copied once per host, recorded in that host's
 * `appliedLegacy`, and kept in `legacy`, so a host that is offline or not listed yet still gets
 * it later. Null when there is nothing to do.
 */
export function planMigration(hosts: readonly HostProjects[]): MigrationPlan | null {
  const writes = new Map<string, DocEdit>();
  const drops = new Map<string, DocEdit>();
  for (const source of hosts) {
    for (const [key, path] of Object.entries(source.doc.legacy)) {
      const legacy = parseLegacyKey(key);
      if (legacy.kind === "equivalence") {
        for (const host of hosts) {
          if (!host.projectKeys || host.doc.appliedLegacy.includes(key)) continue;
          const matches = Object.entries(host.projectKeys).filter(
            ([, projectKey]) => projectKey === legacy.projectKey,
          );
          if (matches.length !== 1) continue;
          const edit = editsFor(writes, host.hostId);
          if (edit.applied.has(key)) continue;
          edit.applied.add(key);
          if (!edit.projects.has(matches[0][0])) edit.projects.set(matches[0][0], path);
        }
        continue;
      }
      const owner = hosts.find((host) => host.hostId === legacy.hostId);
      if (owner?.projectKeys && Object.hasOwn(owner.projectKeys, legacy.projectId)) {
        const edit = editsFor(writes, owner.hostId);
        if (!edit.projects.has(legacy.projectId)) edit.projects.set(legacy.projectId, path);
        editsFor(drops, source.hostId).dropLegacy.add(key);
      } else if (!owner && !legacy.exact) {
        // A host without the plugin: keep it by the key the view reads for that project.
        const edit = editsFor(writes, source.hostId);
        const refKey = projectRefKey(legacy.hostId, legacy.projectId);
        if (!edit.remote.has(refKey)) edit.remote.set(refKey, path);
        editsFor(drops, source.hostId).dropLegacy.add(key);
      }
    }
  }
  if (writes.size === 0 && drops.size === 0) return null;
  const keepExisting = (doc: GroupDoc, edit: DocEdit): GroupDoc =>
    applyEdit(doc, {
      projects: new Map(
        Array.from(edit.projects).filter(([id]) => !Object.hasOwn(doc.projects, id)),
      ),
      remote: new Map(Array.from(edit.remote).filter(([id]) => !Object.hasOwn(doc.remote, id))),
      dropLegacy: edit.dropLegacy,
      applied: edit.applied,
    });
  return {
    writes: new Map(
      Array.from(writes, ([hostId, edit]) => [hostId, (doc: GroupDoc) => keepExisting(doc, edit)]),
    ),
    drops: toChanges(drops),
  };
}
