# project-groups

Paseo plugin. It adds a sidebar view that nests the sidebar's projects into collapsible groups, as many levels deep as you like. Example: `shepherd-companion` holding its `app` and `cdk` projects, so one click collapses both.

## Why

Paseo's default sidebar is a flat list of projects, each with its workspaces. A project has exactly one root folder, so a codebase split across folders or repos (code in `app/`, infrastructure in `cdk/`) becomes several projects that collapse one by one. Paseo has no groups, folders, or nesting. Since Paseo 0.16 a plugin can replace the sidebar's content with its own view, which this plugin does.

## Using it

Select the view under **Settings > Sidebar > Sidebar view > Project groups**. Paseo keeps its header, header items, and footer; the view renders pinned workspaces, then the grouped projects, each with its workspaces. It shows projects of every connected host in one list; with more than one host, project rows also show the host's name.

Rows navigate with one tap or click: a workspace opens it, a project or group row collapses or expands it, and `+` on a project starts a new workspace there. Every other control sits behind **Edit** at the top of the view (and a long press on a row, which opens that row's actions):

- Project: **Move to group** (type a group, or pick an existing one, and press Enter; use `/` to nest: `work/aws`), **Remove from group**, **New workspace**.
- Group: **Rename** (also moves subgroups; type a path with `/` to move it under another group) and **Ungroup** (removes one level: projects move to the parent group, or out of groups at the top level). Both also apply to projects grouped only by their name.
- Workspace: **Pin** or **Unpin**, **Rename**, **Archive** (asks to confirm).
- Order: in edit mode every project, group, and workspace row has move up and move down buttons. A group moves with everything in it. **Done** leaves edit mode; edit mode itself is not saved.

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

`client/groups.ts` (grouping, placement, rename and ungroup rewrites), `client/assignments.ts` (where assignments live across hosts, and the 0.15 migration), and `client/order.ts` (ordering and moves) are pure functions with tests. `client/web.ts` holds the only DOM access, the one-time read of the 0.15 collapsed groups.

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
