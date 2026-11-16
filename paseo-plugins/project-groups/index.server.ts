import type { PluginServerContext } from "@getpaseo/plugin/server";
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
  return () => {};
}
