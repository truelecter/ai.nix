import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startHostGroups } from "./client/registry.ts";
import { GroupsView } from "./client/view.tsx";

export default function contribute(client: PluginClientContext) {
  // Runs once per connected host: each publishes its host's groups for the one rendered view.
  const stopHost = startHostGroups(client);
  const removeView = client.addSidebarView({
    id: "groups",
    title: "Project groups",
    description: "Projects nested in collapsible groups, with pinned workspaces on top.",
    Component: GroupsView,
  });
  return () => {
    void removeView();
    stopHost();
  };
}
