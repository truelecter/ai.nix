import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Daemon requests the plugin SDK has no call for. The plugin's server sends them to its own
// daemon as Paseo's sidebar does (server/daemon.ts).

/** Forgets a project and archives its workspaces, as Paseo's project menu does. Files stay. */
export const removeProject = defineRpc({
  name: "projects.remove",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ removedWorkspaceIds: z.array(z.string()) }),
});

/** The project's icon (its own or a discovered one), or null for the lettered square. */
export const projectIcon = defineRpc({
  name: "projects.icon",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({
    icon: z.object({ data: z.string(), mimeType: z.string() }).nullable(),
  }),
});

/** Paseo's Mark as read: clears the attention of the workspace's agents. */
export const markWorkspaceRead = defineRpc({
  name: "workspaces.mark-read",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({}),
});

/** Paseo's Mark as unread. */
export const markWorkspaceUnread = defineRpc({
  name: "workspaces.mark-unread",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({}),
});
