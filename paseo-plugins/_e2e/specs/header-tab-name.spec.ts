import { expect, openAgent, test } from "../support/fixtures";
import { createMockAgent, finishTurn } from "../support/paseo";

// The plugin appends `› <tab name>` to the workspace header's title row (`.htn-label`, a node of
// its own next to `workspace-header-title`).
test("the workspace header shows the name of the open agent tab", async ({
  page,
  seed,
}) => {
  const workspace = await seed("header-tab-name");
  const first = await createMockAgent(workspace, {
    title: "First agent with a long descriptive title",
    initialPrompt: "hi",
  });
  const second = await createMockAgent(workspace, {
    title: "Second agent in the same workspace",
    initialPrompt: "hi",
  });
  await finishTurn(workspace.client, first);
  await finishTurn(workspace.client, second);

  await openAgent(page, workspace.workspaceId, first);
  const titleRow = page.getByTestId("workspace-header-title").locator("..");
  const label = titleRow.locator(".htn-label");
  await expect(label).toHaveText("First agent with a long descriptive title");
  await expect(label).toHaveAttribute(
    "title",
    "First agent with a long descriptive title",
  );

  await page.getByTestId(`workspace-tab-agent_${second}`).click();
  await expect(label).toHaveText("Second agent in the same workspace");
});

// Since Paseo 0.16 a pane narrower than 500px swaps its header and tabs row for the compact header,
// which shows the open tab in its tab switcher. At 760px the docked sidebar (320px) leaves the
// single pane about 440px, so the compact header shows on the desktop layout. The plugin leaves it
// alone and names the full header again once the window is wide.
test("the compact pane header gets no tab name, and the full header gets it back", async ({
  page,
  seed,
}) => {
  const workspace = await seed("header-tab-name-compact");
  const agent = await createMockAgent(workspace, {
    title: "Agent behind the compact header",
    initialPrompt: "hi",
  });
  await finishTurn(workspace.client, agent);

  await openAgent(page, workspace.workspaceId, agent);
  const title = page.getByTestId("workspace-header-title");
  const label = title.locator("..").locator(".htn-label");
  await expect(label).toHaveText("Agent behind the compact header");

  await page.setViewportSize({ width: 760, height: 1000 });
  const paneTabsRow = page.locator(
    '[data-testid^="workspace-pane-"] [data-testid="workspace-tabs-row"]',
  );
  await expect(paneTabsRow).toHaveCount(0);
  await expect(title).toBeVisible();
  await expect(page.locator(".htn-tab")).toHaveCount(0);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(paneTabsRow).toHaveCount(1);
  await expect(label).toHaveText("Agent behind the compact header");
});
