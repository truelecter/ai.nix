import type {
  PluginHandlerContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import {
  archiveAgent,
  getSnapshot,
  killProcess,
  quitApp,
  screenSettings,
  type Snapshot,
} from "./shared/health.ts";
import * as actions from "./server/actions.ts";
import { collect } from "./server/collect.ts";
import { buildSnapshot, type AgentInfo } from "./server/model.ts";

async function listAgents({
  paseo,
}: PluginHandlerContext): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];
  let cursor: string | undefined;
  do {
    // Background agents (helpers hidden from tabs and lists) run omp sessions too; without them
    // their sessions would show as having no Paseo agent and be offered for a kill.
    const page = await paseo.agents.list({
      filter: { includeArchived: true, includeBackground: true },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries) {
      agents.push({
        id: agent.id,
        title: agent.title,
        status: agent.status,
        archived: !!agent.archivedAt,
        background: agent.background === true,
        cwd: agent.cwd,
        sessionId:
          agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null,
        lastActivityAt: agent.updatedAt,
      });
    }
    cursor = page.pageInfo.hasMore
      ? (page.pageInfo.nextCursor ?? undefined)
      : undefined;
  } while (cursor);
  return agents;
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(screenSettings);

  // Several open screens (desktop and phone) share one sample instead of running top side by side.
  let inFlight: Promise<Snapshot> | null = null;
  server.handle(getSnapshot, (_input, context) => {
    inFlight ??= collect(() => listAgents(context))
      .then(buildSnapshot)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  });

  server.handle(archiveAgent, ({ agentId }, { paseo }) =>
    paseo.agents.ref(agentId).archive(),
  );
  server.handle(quitApp, async ({ bundlePath }) => {
    await actions.quitApp(bundlePath);
    return {};
  });
  server.handle(killProcess, async ({ pid, name }) => {
    await actions.killProcess(pid, name);
    return {};
  });

  return () => {};
}
