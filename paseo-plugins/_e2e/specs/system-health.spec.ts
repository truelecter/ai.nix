import { expect, openApp, test } from "../support/fixtures";
import { type Client, createMockAgent } from "../support/paseo";

/** Every agent the daemon has, archived and background ones included, as the plugin reads them. */
async function countAgents(client: Client) {
  let live = 0;
  let background = 0;
  let archived = 0;
  let cursor: string | undefined;
  do {
    const page = await client.fetchAgents({
      filter: { includeArchived: true, includeBackground: true },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries) {
      if (agent.archivedAt) archived++;
      else {
        live++;
        if (agent.background) background++;
      }
    }
    cursor = page.pageInfo.hasMore
      ? (page.pageInfo.nextCursor ?? undefined)
      : undefined;
  } while (cursor);
  return { live, background, archived };
}

// The plugin samples macOS tools (top, vm_stat, lsof); its package exists only on Darwin, so the
// harness loads it only there.
test.skip(process.platform !== "darwin", "system-health is macOS only");

test("the System health screen samples this Mac, counts the daemon's agents with background ones, and keeps the refresh interval", async ({
  page,
  seed,
}) => {
  const workspace = await seed("system-health");
  await createMockAgent(workspace, {
    title: "Health check agent",
    initialPrompt: "hello",
  });
  // A background agent: hidden from Paseo's default agent list, still a running session.
  const helper = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Health check background helper",
    modeId: "load-test",
    model: "e2e-fast-stream",
    background: true,
  });
  const visible = await workspace.client.fetchAgents({
    filter: { includeArchived: true },
    page: { limit: 200 },
  });
  expect(visible.entries.map(({ agent }) => agent.id)).not.toContain(helper.id);
  const counts = await countAgents(workspace.client);
  expect(counts.background).toBeGreaterThan(0);

  await openApp(page);
  await page.getByTestId("plugin-sidebar-system-health-system-health").click();
  const memory = page.getByTestId("system-health-memory");
  await expect(memory).toContainText(/Pressure: (normal|warning|critical)/);
  await expect(memory).toContainText(/Swap/);
  // A real sample: app rows with footprints, and the agent list read through the plugin API.
  await expect(page.getByTestId("system-health-apps")).toContainText(
    /\d+(\.\d)? (MB|GB)/,
  );
  await expect(page.getByTestId("system-health-agents")).toContainText(
    `Paseo has ${counts.live} agents (${counts.background} background), ${counts.archived} archived.`,
  );

  const tenSeconds = page.getByLabel("Refresh every 10 seconds");
  const off = page.getByLabel("No automatic refresh");
  await expect(off).toHaveAttribute("aria-selected", "true");
  await tenSeconds.click();
  await expect(tenSeconds).toHaveAttribute("aria-selected", "true");
  try {
    // The interval is a host setting, so it survives a reload (which reopens the screen).
    await page.reload();
    await expect(page.getByLabel("Refresh every 10 seconds")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    await page.getByLabel("No automatic refresh").click();
    await expect(page.getByLabel("No automatic refresh")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
});
