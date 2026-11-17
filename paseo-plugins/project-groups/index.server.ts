import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDaemonConnection } from "./server/daemon.ts";
import {
  markWorkspaceRead,
  markWorkspaceUnread,
  projectIcon,
  removeProject,
} from "./shared/daemon.ts";
import { groupChanges, groupSettings } from "./shared/settings.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(groupSettings);
  // Clients of this host refresh their copy when another client saves a change. The handler
  // returns nothing, so the subscription stays open until the client releases it.
  server.handle(groupChanges, (_input, { push, signal }) => {
    const send = (revision: string) =>
      push({ revision }).catch((error: unknown) => {
        if (!signal.aborted) console.warn("[project-groups] Could not push a group change", error);
      });
    const stop = settings.subscribe((state) => send(state.revision));
    signal.addEventListener("abort", () => void stop(), { once: true });
    void settings
      .read()
      .then((current) => send(current.revision))
      .catch((error: unknown) => console.error("[project-groups] Could not read groups", error));
  });

  const daemon = createDaemonConnection();
  server.handle(removeProject, ({ projectId }) =>
    daemon.use((client) => client.removeProject(projectId)),
  );
  server.handle(projectIcon, ({ projectId }) =>
    daemon.use(async (client) => {
      const result = await client.getProjectIcon(projectId);
      if (result.error) throw new Error(result.error);
      return { icon: result.icon };
    }),
  );
  server.handle(markWorkspaceRead, ({ workspaceId }) =>
    daemon.use(async (client) => {
      await client.clearWorkspaceAttention(workspaceId);
      return {};
    }),
  );
  server.handle(markWorkspaceUnread, ({ workspaceId }) =>
    daemon.use(async (client) => {
      await client.markWorkspaceUnread(workspaceId);
      return {};
    }),
  );
  return () => daemon.close();
}
