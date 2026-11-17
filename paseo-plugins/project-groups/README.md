# project-groups

Paseo plugin. It adds a sidebar view that nests the sidebar's projects into collapsible groups, as many levels deep as you like. Example: `shepherd-companion` holding its `app` and `cdk` projects, so one click collapses both.

## Why

Paseo's default sidebar is a flat list of projects, each with its workspaces. A project has exactly one root folder, so a codebase split across folders or repos (code in `app/`, infrastructure in `cdk/`) becomes several projects that collapse one by one. Paseo has no groups, folders, or nesting. Since Paseo 0.16 a plugin can replace the sidebar's content with its own view, which this plugin does.

## Using it

Select the view under **Settings > Sidebar > Sidebar view > Project groups**. Paseo keeps its header, header items, and footer; the view renders a **Pinned** section, then a **Projects** section with the grouped projects, each with its workspaces. The **Projects** header sticks to the top of the view, full width with a hairline under it, while the list scrolls under it. Its backdrop is the sidebar color read from the page; on phones and tablets, where the plugin theme doesn't carry that color, it is estimated from the theme and painted only while rows pass under the header, so at rest the header shows the real sidebar. It shows projects of every connected host in one list; with more than one host, project rows also show the host's name.

Rows navigate with one tap or click: a workspace opens it, and a project or group row collapses or expands it. Rows look like Paseo's default view: a project shows its icon (its own, or Paseo's lettered square in the same color), turning into the chevron on hover; a workspace shows Paseo's status mark (the turning ring while it runs, an alert when it needs input, a dot when it is ready to review, a faint dot when idle, its kind with a red dot when it failed) and, at its end, its last interaction (`now`, `5m`, `2h`, `3d`, then the date). Row text can't be selected. With a pointer, a row's controls appear only while it is hovered and take the place of the time; touch layouts always show the time and `⋮`:

- Workspace: the archive button and the `⋮` menu. A local checkout archives at once with a pointer; a worktree (its folder goes with it) asks first. On touch layouts Archive sits in the menu, where it asks first too.
- Project: `+` starts a new workspace there, and the `⋮` menu.

A right-click (long press on touch) opens the same menu as `⋮`, a dropdown at the pointer and a bottom sheet on touch layouts:

- Project: **Open project settings**, **Open in new window** and **Open in file manager** (desktop app only), **Move to group**, **Remove from group**, **Remove project** (asks first; files on disk stay).
- Workspace: **Copy path**, **Copy branch name**, **Rename**, **Mark as read** or **Mark as unread**, **Pin** or **Unpin**, **Labels** (check the host's labels, or type a new one), **Open in file manager** (desktop app only), **Archive**.
- Group: **Rename group**, **Ungroup**.

Text and row sizes follow Paseo's sidebar at its default UI font size: 14pt text and 36pt rows on the desktop and web, 15pt text and 44pt rows on touch layouts. The plugin theme carries colors only, so a custom **Interface font size** in Paseo's Appearance settings doesn't reach the view, and the status colors are Paseo's, picked by the theme's lightness.

Each section has its own edit mode (a check mark in the header turns it off; edit mode itself is not saved). The **Pinned** header turns it on with its pencil; the **Projects** header has Paseo's display preferences button, whose menu holds **Sort** and **Edit groups and order**. Workspace actions stay in the row menus.

- Sort (saved on this device): **Manual** (the order set in edit mode, then by title), **Created** (newest first), or **Last prompt** (newest first, a workspace with no prompt yet by its creation), as Paseo's own Sort. It orders each project's workspaces; pinned workspaces keep their own order.
- Pinned: move up and move down buttons on every pinned workspace. A newly pinned workspace, or one pinned again, goes on top.
- Projects, on a project: **Move to group** (type a group, or pick an existing one, and press Enter; use `/` to nest: `work/aws`) and **Remove from group**.
- Projects, on a group: **Rename** (also moves subgroups; type a path with `/` to move it under another group) and **Ungroup** (removes one level: projects move to the parent group, or out of groups at the top level). Both also apply to projects grouped only by their name.
- Projects, order: every project and group row has move up and move down buttons, and so does every workspace row while the sort is **Manual**. A group moves with everything in it.

A project's group comes from, in order:

1. An assignment made with **Move to group**, stored on the project's host.
2. Its name. A project whose name contains `/` is grouped by everything before the last `/`. Rename a project to `shepherd-companion/app` (project settings in Paseo) and it shows as `app` under `shepherd-companion`. This works without the plugin's storage and keeps the projects together in Paseo's default view too.

A collapsed group shows how many projects it holds and a status dot for the most urgent state among its workspaces (needs input, failed, running, ready to review). A collapsed project shows its workspace count and the same dot. Screen readers hear the group's state in the row's label and its expanded state.

Without a stored order, projects sort by name and a group sits where its first project would be. Moving rows stores the full order on the device.

## Where things are stored

| What | Where | Shared |
| --- | --- | --- |
| Group assignments | Host plugin settings of the project's host, `~/.paseo/plugin-settings/project-groups/groups.json` | All clients of that host |
| Collapsed groups and projects, order | Device plugin settings (`layout`) | This device only |

The host document (version 2) has `projects` (this host's project ID -> group path), `remote` (projects of connected hosts that don't run the plugin, keyed by the cross-host ref key `JSON.stringify([hostId, projectId])`, kept on the first host that runs it), `legacy`, and `appliedLegacy`. An empty path keeps a `/`-named project out of the group its name implies. Clients of a host pick up changes from other clients through a plugin subscription the daemon pushes on every save.

Upgrading from the Paseo 0.15 version: the daemon migrates the version 1 document (`assignments`, keyed by the old sidebar's project view key) into `legacy`. Once every host running the plugin has loaded, the view copies each entry to its project using the hosts' project listings (`paseo.projects.list()`), and never replaces an assignment the project already has. A `[serverId, projectId]` or `["placement", serverId, projectId, n]` key names one project: it is copied there and then removed from `legacy`. A shared project key goes to the project with that key on each listed host where exactly one project has it (as 0.15 matched it); it stays in `legacy`, and each host records it in its `appliedLegacy` once copied, so a host that was offline gets it when it is listed and a removed copy doesn't come back. Entries that match nothing yet (a project that is gone, a host that is offline) stay and are retried when the projects change. The 0.15 web version's collapsed groups in browser storage (`paseo-plugin:project-groups:collapsed`) are imported once into the device settings.

## How it works

Paseo evaluates the client entry once per connected host but renders the sidebar view once, under one host's installation, whose RPCs reach only that host. So `index.client.ts` starts `client/registry.ts` for every installation: it learns its host's server ID (`paseo.hosts.list()`), keeps that host's document in sync through the settings RPCs (`client/sync.ts`: changes show at once, save with the last known revision, and are re-applied on a conflict; an invalid stored document is never overwritten), and publishes it on a plugin-owned global under a versioned symbol. The view (`client/view.tsx`) reads every host from there and sends each project's change to its own host. An installation removes its entry when it stops.

The view uses only React Native primitives and the SDK's `useProjects`, `useWorkspaces`, and `useWorkspace`: project names come from one `groupBy` query, each row reads its own workspaces and status, and a collapsed group's status comes from a `groupBy` on workspace indicators. Colors come from the theme tokens Paseo passes to the view.

`client/groups.ts` (grouping, placement, rename and ungroup rewrites), `client/assignments.ts` (where assignments live across hosts, and the 0.15 migration), and `client/order.ts` (ordering and moves) are pure functions with tests. `client/web.ts` holds the web and desktop-only access: the one-time read of the 0.15 collapsed groups, opening **Open project settings** in the window (a pushed route plus `popstate`, which Paseo's web router follows; phones open the `paseo://` link instead), and the desktop app's `window.paseoDesktop` bridge for new windows and the file manager, the same calls Paseo's own project menu makes.

The SDK has no call to remove a project, read a project's icon, or mark a workspace read or unread, so those go through plugin RPCs to the project's host. Its server (`server/daemon.ts`) keeps one connection to its own daemon, opened as Paseo's CLI does from the address in `<PASEO_HOME>/paseo.pid` and the token in `<PASEO_HOME>/local-credential`, and sends the same requests as Paseo's sidebar (`project.remove.request`, `project.icon.get.request`, clearing a workspace's attention, `markWorkspaceUnread`). That bundles `@getpaseo/client` into the server entry (about 10 MB), which adds about a second to the plugin's start. Projects of hosts that don't run the plugin get the lettered icon and no **Remove project** or read state items. Mark as unread doesn't unfocus the workspace as Paseo's does, so on a workspace you are looking at it can clear again at once.

## Limits

- Reordering is by move buttons in edit mode; there is no drag and drop.
- A host's assignments need the plugin running on that host or, for hosts without it, on another connected host. With no connected host running it, the view shows projects grouped only by their names.
- Workspace shortcuts (Cmd+1-9) follow Paseo's own order, not this view's.

## Develop

Installed through `programs.paseo.plugins.project-groups` (this flake's `homeModules.paseo` Home Manager module). To work on it without a switch, run `paseo-plugin-dev link project-groups` from your checkout: Paseo then loads this folder, `paseo plugin reload project-groups` picks up each edit, and `paseo plugin logs project-groups` shows its output. `paseo-plugin-dev restore project-groups` goes back to the installed build. See `AGENTS.md` at the repository root.

```sh
nix shell --inputs-from "$(git rev-parse --show-toplevel)" latest#bun \
  -c sh -c 'bun install --frozen-lockfile && bun run typecheck && bun run test'
rm -rf node_modules
nix build .#paseo-plugin-project-groups -L
```

The end-to-end spec (`_e2e/specs/project-groups.spec.ts`) selects the view through the app's `sidebar.view` storage key (`project-groups/groups`) and covers grouping in edit mode, name-based groups, the 0.15 migration, and reordering.
