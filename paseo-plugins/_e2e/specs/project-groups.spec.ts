import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { env } from "../support/env";
import { workspaceRoute } from "../support/paseo";
import { expect, openApp, test } from "../support/fixtures";

// The plugin is a sidebar view ("project-groups/groups"). Paseo keeps the selected view in the
// app's storage under `sidebar.view`, so each page selects it before the app starts. Rows carry
// test IDs with the SDK's cross-host ref keys (`JSON.stringify([serverId, id])`).

const settingsFile = path.join(env.home, "plugin-settings", "project-groups", "groups.json");

function refKey(id: string): string {
  return JSON.stringify([env.serverId, id]);
}

function stored(): {
  version: number;
  values: { projects?: Record<string, string>; [key: string]: unknown };
} | null {
  try {
    return JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {
    return null;
  }
}

async function openGroups(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("sidebar.view", "project-groups/groups"));
  await openApp(page);
  await expect(page.getByTestId("project-groups-view")).toBeVisible({ timeout: 30_000 });
  // The host's group document has loaded once the notice is gone.
  await expect(page.getByTestId("project-groups-loading")).toHaveCount(0, { timeout: 30_000 });
}

test("a project moved to a group in edit mode is nested under the group row", async ({
  page,
  seed,
}) => {
  const workspace = await seed("project-groups");
  await openGroups(page);

  const row = page.getByTestId(`project-groups-project-${refKey(workspace.projectId)}`);
  await expect(row).toBeVisible();
  // Normal mode shows no order or group controls.
  await expect(page.getByTestId(`project-groups-project-${refKey(workspace.projectId)}-up`)).toHaveCount(0);

  await page.getByTestId("project-groups-edit").click();
  await page.getByTestId(`project-groups-project-${refKey(workspace.projectId)}-assign`).click();
  const input = page.getByTestId("project-groups-input");
  await input.fill("E2E group");
  await input.press("Enter");

  const header = page.getByTestId("project-groups-group-E2E group");
  await expect(header).toHaveAttribute("aria-label", "E2E group, 1 project");
  await page.getByTestId("project-groups-edit").click();

  // Assignments are host settings on the daemon, keyed by this host's project ID.
  await expect.poll(() => stored()?.values.projects?.[workspace.projectId]).toBe("E2E group");
  await page.reload();
  await expect(page.getByTestId("project-groups-view")).toBeVisible({ timeout: 30_000 });
  await expect(header).toHaveAttribute("aria-expanded", "true");

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  await header.click();
  await expect(row).toBeVisible();

  await page.getByTestId(`project-groups-workspace-${refKey(workspace.workspaceId)}`).click();
  await expect(page).toHaveURL((url) => url.pathname === workspaceRoute(workspace.workspaceId));
});

test("a project named `group/name` is grouped by its name", async ({ page, seed, client }) => {
  const workspace = await seed("project-groups-named");
  await client.renameProject(workspace.projectId, "Named group/app");
  await openGroups(page);

  await expect(page.getByTestId("project-groups-group-Named group")).toBeVisible();
  await expect(
    page.getByTestId(`project-groups-project-${refKey(workspace.projectId)}-label`),
  ).toHaveText("app");
});

test("Paseo 0.15 assignments move to their projects", async ({ page, seed }) => {
  const shared = await seed("project-groups-legacy-shared");
  const placed = await seed("project-groups-legacy-placed");
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      values: {
        assignments: {
          [shared.projectKey]: "Legacy/shared",
          [refKey(placed.projectId)]: "Legacy",
        },
      },
    }),
  );
  await openGroups(page);

  await expect(page.getByTestId("project-groups-group-Legacy")).toBeVisible();
  await expect(page.getByTestId("project-groups-group-Legacy/shared")).toBeVisible();
  // The placement key moves to its project; the shared project key is copied and kept, so a
  // host listed later still gets it.
  await expect
    .poll(() => {
      const file = stored();
      return file && { version: file.version, ...file.values };
    })
    .toEqual({
      version: 2,
      projects: { [shared.projectId]: "Legacy/shared", [placed.projectId]: "Legacy" },
      remote: {},
      legacy: { [shared.projectKey]: "Legacy/shared" },
      appliedLegacy: [shared.projectKey],
    });
});

test("edit mode reorders projects and the order survives a reload", async ({ page, seed }) => {
  const first = await seed("project-groups-order-a");
  const second = await seed("project-groups-order-b");
  await openGroups(page);

  const firstRow = page.getByTestId(`project-groups-project-${refKey(first.projectId)}`);
  const secondRow = page.getByTestId(`project-groups-project-${refKey(second.projectId)}`);
  const above = async () =>
    ((await firstRow.boundingBox())?.y ?? 0) < ((await secondRow.boundingBox())?.y ?? 0);
  await expect.poll(above).toBe(true);

  await page.getByTestId("project-groups-edit").click();
  await page.getByTestId(`project-groups-project-${refKey(second.projectId)}-up`).click();
  await expect.poll(above).toBe(false);
  await page.getByTestId("project-groups-edit").click();
  await expect(page.getByTestId(`project-groups-project-${refKey(second.projectId)}-up`)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("project-groups-view")).toBeVisible({ timeout: 30_000 });
  await expect(secondRow).toBeVisible();
  await expect.poll(above).toBe(false);
});

test("edit mode reorders pinned workspaces and the order survives a reload", async ({
  page,
  seed,
  client,
}) => {
  const first = await seed("project-groups-pinned-a");
  const second = await seed("project-groups-pinned-b");
  await client.setWorkspacePinned(first.workspaceId, true);
  await client.setWorkspacePinned(second.workspaceId, true);
  await openGroups(page);

  const pinned = page.getByTestId("project-groups-pinned");
  const row = (id: string) => pinned.getByTestId(`project-groups-workspace-${refKey(id)}`);
  const above = async () =>
    ((await row(first.workspaceId).boundingBox())?.y ?? 0) <
    ((await row(second.workspaceId).boundingBox())?.y ?? 0);
  // Pinned in this order, so shown in it until moved.
  await expect.poll(above).toBe(true);

  await page.getByTestId("project-groups-edit").click();
  await page.getByTestId(`project-groups-workspace-${refKey(second.workspaceId)}-up`).click();
  await expect.poll(above).toBe(false);

  await page.reload();
  await expect(row(second.workspaceId)).toBeVisible({ timeout: 30_000 });
  await expect.poll(above).toBe(false);
});

test("a pinned workspace archives from its row without edit mode", async ({
  page,
  seed,
  client,
}) => {
  const workspace = await seed("project-groups-archive");
  await client.setWorkspacePinned(workspace.workspaceId, true);
  await openGroups(page);

  const row = page
    .getByTestId("project-groups-pinned")
    .getByTestId(`project-groups-workspace-${refKey(workspace.workspaceId)}`);
  const archive = page.getByTestId(`project-groups-workspace-${refKey(workspace.workspaceId)}-archive`);
  // As in Paseo's sidebar: the last interaction until hovered, then the row's buttons in its place.
  await expect(row.locator("..").getByTestId("project-groups-workspace-time")).toHaveText(
    /^(now|\d+m)$/,
  );
  await expect(archive).toHaveCount(0);
  await row.hover();
  // A local checkout archives at once with a pointer, as in Paseo's own sidebar.
  await archive.click();
  await expect
    .poll(async () =>
      (await client.fetchWorkspaces()).entries.some((entry) => entry.id === workspace.workspaceId),
    )
    .toBe(false);
  await expect(row).toHaveCount(0);
});

test("the project menu opens the project's settings and removes the project", async ({
  page,
  seed,
  client,
}) => {
  const workspace = await seed("project-groups-menu");
  await openGroups(page);

  const testID = `project-groups-project-${refKey(workspace.projectId)}`;
  await page.getByTestId(testID).hover();
  await page.getByTestId(`${testID}-actions`).click();
  await page.getByTestId(`${testID}-menu-settings`).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname ===
      `/settings/hosts/${encodeURIComponent(env.serverId)}/projects/${encodeURIComponent(workspace.projectId)}`,
  );

  await openGroups(page);
  await page.getByTestId(testID).hover();
  await page.getByTestId(`${testID}-actions`).click();
  await page.getByTestId(`${testID}-menu-remove`).click();
  await expect(page.getByTestId(`${testID}-actions-menu`)).toContainText(
    "Files on disk will not be changed.",
  );
  await page.getByTestId(`${testID}-actions-menu-confirm`).click();
  await expect
    .poll(async () =>
      (await client.listProjects()).projects.some(
        (project) => project.projectId === workspace.projectId,
      ),
    )
    .toBe(false);
  await expect(page.getByTestId(testID)).toHaveCount(0);
});

test("a right-click on a workspace opens its menu, which pins it and sets a label", async ({
  page,
  seed,
  client,
}) => {
  const workspace = await seed("project-groups-context");
  await openGroups(page);

  const testID = `project-groups-workspace-${refKey(workspace.workspaceId)}`;
  const entry = async () =>
    (await client.fetchWorkspaces()).entries.find((item) => item.id === workspace.workspaceId);

  await page.getByTestId(testID).click({ button: "right" });
  await page.getByTestId(`${testID}-menu-pin`).click();
  await expect.poll(async () => (await entry())?.pinnedAt ?? null).not.toBeNull();

  await page.getByTestId(testID).click({ button: "right" });
  await page.getByTestId(`${testID}-menu-labels`).click();
  const input = page.getByTestId("project-groups-label-input");
  await input.fill("E2E label");
  await input.press("Enter");
  await expect.poll(async () => (await entry())?.labels ?? []).toContain("E2E label");
});
