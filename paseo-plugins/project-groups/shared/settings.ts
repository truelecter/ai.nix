import { defineSettings, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

const paths = z.record(z.string(), z.string()).default({});

export const groupSettings = defineSettings({
  id: "groups",
  scope: "host",
  version: 2,
  schema: z.object({
    // This host's project ID -> group path ("work/aws"). An empty path keeps a project out of the
    // group its name would put it in.
    projects: paths,
    // Projects of hosts that don't run this plugin, keyed by their cross-host ref key
    // (`JSON.stringify([hostId, projectId])`).
    remote: paths,
    // Version 1 assignments keyed by Paseo 0.15's sidebar project view key (a shared project key,
    // or a JSON placement). The client copies each one to its project once it can resolve it. A
    // placement names one project and is removed once copied; a shared project key can name a
    // project on any host, so it stays for hosts listed later.
    legacy: paths,
    // Shared project keys from any host's `legacy` already copied to this host's projects, so a
    // later removal of the copy is not undone.
    appliedLegacy: z.array(z.string()).default([]),
  }),
  migrate: (values, fromVersion) => {
    if (fromVersion !== 1) throw new Error(`Unknown group settings version ${fromVersion}`);
    const old = z
      .object({ assignments: z.record(z.string(), z.string()).default({}) })
      .parse(values);
    return { projects: {}, remote: {}, legacy: old.assignments, appliedLegacy: [] };
  },
});

export type GroupDoc = z.output<typeof groupSettings.schema>;

export const emptyGroupDoc: GroupDoc = { projects: {}, remote: {}, legacy: {}, appliedLegacy: [] };

/** Pushes once on subscribe and after every saved change of the group document. */
export const groupChanges = defineSubscription({
  name: "groups.changed",
  input: z.object({}),
  event: z.object({ revision: z.string() }),
});

// Layout choices of this device: never synced to other devices.
export const layoutSettings = defineSettings({
  id: "layout",
  scope: "device",
  version: 1,
  schema: z.object({
    /** Collapsed group paths. */
    collapsedGroups: z.array(z.string()).default([]),
    /** Collapsed projects, by project ref key. */
    collapsedProjects: z.array(z.string()).default([]),
    /** Project ref keys in display order; projects missing here follow by name. */
    projectOrder: z.array(z.string()).default([]),
    /** Project ref key -> workspace ref keys in display order. */
    workspaceOrder: z.record(z.string(), z.array(z.string())).default({}),
    /** Set once the browser's Paseo 0.15 collapsed groups were imported. */
    importedWebCollapsed: z.boolean().default(false),
  }),
});

export type LayoutPrefs = z.output<typeof layoutSettings.schema>;
