// The sidebar view: pinned workspaces, then projects nested in their groups, each with its
// workspaces. Rows navigate; group, rename, pin, archive and order controls live behind a long
// press on a row or the Edit toggle, so normal navigation stays one tap.

import {
  useHosts,
  usePaseo,
  useProjects,
  useSettings,
  useWorkspace,
  useWorkspaces,
  type PluginSidebarViewProps,
  type ProjectRef,
  type SettingsState,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import type { WorkspaceIndicator } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { layoutSettings, type LayoutPrefs } from "../shared/settings.ts";
import {
  effectiveAssignments,
  planMigration,
  planWrites,
  type AssignmentWrite,
} from "./assignments.ts";
import {
  assignProject,
  buildLayout,
  dissolveGroup,
  groupPaths,
  moveCollapsed,
  moveGroup,
  normalizeGroupPath,
  parentGroupPath,
  pickGroupStatus,
  placeProject,
  suggestGroups,
  type Assignments,
  type LayoutEntry,
  type SidebarProject,
  type StatusBucket,
} from "./groups.ts";
import {
  compareNames,
  compareOrdered,
  entryId,
  moveItem,
  moveSibling,
  orderIndex,
  siblingMoves,
} from "./order.ts";
import { useHostGroups } from "./registry.ts";
import { readLegacyCollapsed } from "./web.ts";

type GroupEntry = Extract<LayoutEntry, { kind: "group" }>;
type ProjectEntry = Extract<LayoutEntry, { kind: "project" }>;
type Direction = -1 | 1;

interface Editor {
  id: string;
  kind: "assign" | "rename-group" | "rename-workspace";
  initial: string;
}

interface Actions {
  toggleGroup(path: string): void;
  toggleProject(key: string): void;
  assign(key: string, rawPath: string): void;
  renameGroup(from: string, rawTo: string): void;
  ungroup(path: string): void;
  moveRow(id: string, direction: Direction): void;
  moveWorkspace(projectKey: string, keys: readonly string[], key: string, direction: Direction): void;
  run(work: () => Promise<unknown>, what: string): void;
}

interface ViewContextValue {
  view: PluginSidebarViewProps;
  styles: Styles;
  iconSize: number;
  editing: boolean;
  menu: string | null;
  toggleMenu(id: string): void;
  editor: Editor | null;
  setEditor(editor: Editor | null): void;
  prefs: LayoutPrefs;
  paths: readonly string[];
  moves: ReadonlyMap<string, { up: boolean; down: boolean }>;
  pathOf(key: string): string;
  hostLabel(hostId: string): string | null;
  actions: Actions;
}

const ViewContext = createContext<ViewContextValue | null>(null);

function useView(): ViewContextValue {
  const value = useContext(ViewContext);
  if (!value) throw new Error("project-groups rows must render inside the groups view");
  return value;
}

const NONE: readonly string[] = Object.freeze([]);
const DEFAULT_PREFS: LayoutPrefs = layoutSettings.schema.parse({});
const INDENT = 12;

function createStyles(theme: PluginSidebarViewProps["theme"], compact: boolean) {
  const { colors } = theme;
  const control = compact ? 32 : 22;
  return StyleSheet.create({
    root: { flex: 1 },
    content: { paddingBottom: 12 },
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: compact ? 40 : 30,
      paddingHorizontal: 12,
      gap: 8,
    },
    heading: { flex: 1, color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    section: {
      color: colors.foregroundMuted,
      fontSize: 11,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 2,
    },
    row: { flexDirection: "row", alignItems: "center", paddingRight: 8, gap: 2 },
    rowMain: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      minHeight: compact ? 36 : 28,
      gap: 6,
      paddingRight: 4,
      borderRadius: 4,
    },
    pressed: { backgroundColor: colors.surface1 },
    active: { backgroundColor: colors.surface2 },
    label: { flexShrink: 1, color: colors.foreground, fontSize: 12, lineHeight: 16 },
    groupLabel: {
      flexShrink: 1,
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: "600",
    },
    spacer: { flex: 1 },
    detail: { color: colors.foregroundMuted, fontSize: 11 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    dotSlot: { width: 14, alignItems: "center", justifyContent: "center" },
    button: {
      minWidth: control,
      minHeight: control,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 4,
    },
    textButton: {
      minHeight: control,
      paddingHorizontal: 8,
      justifyContent: "center",
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    textButtonLabel: { color: colors.foreground, fontSize: 11 },
    dangerLabel: { color: colors.statusDanger, fontSize: 11 },
    strip: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingRight: 8, paddingVertical: 4 },
    editor: { gap: 6, paddingRight: 8, paddingVertical: 4 },
    input: {
      color: colors.foreground,
      fontSize: 12,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: compact ? 8 : 4,
    },
    notice: { color: colors.foregroundMuted, fontSize: 11, paddingHorizontal: 12, paddingVertical: 4 },
    error: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    errorText: { flexShrink: 1, color: colors.statusDanger, fontSize: 11 },
  });
}

type Styles = ReturnType<typeof createStyles>;

function indicatorColor(
  theme: PluginSidebarViewProps["theme"],
  status: StatusBucket | WorkspaceIndicator | null,
): string | null {
  switch (status) {
    case "needs_input":
      return theme.colors.statusWarning;
    case "failed":
      return theme.colors.statusDanger;
    case "running":
      return theme.colors.accent;
    case "attention":
      return theme.colors.statusSuccess;
    default:
      return null;
  }
}

const STATUS_LABELS: Record<StatusBucket, string> = {
  needs_input: "needs input",
  failed: "failed",
  running: "running",
  attention: "ready to review",
};

function StatusDot({ status }: { status: StatusBucket | WorkspaceIndicator | null }) {
  const { view, styles } = useView();
  const color = indicatorColor(view.theme, status);
  return (
    <View style={styles.dotSlot}>
      {color ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
    </View>
  );
}

/** The most urgent status among the visible workspaces of `projectKeys`. */
function useAggregateStatus(projectKeys: readonly string[]): StatusBucket | null {
  const keys = useMemo(() => new Set(projectKeys), [projectKeys]);
  const buckets = useWorkspaces({
    where: (workspace) => !workspace.background && keys.has(workspace.project.key),
    groupBy: (workspace) => workspace.indicator,
  });
  return pickGroupStatus(buckets.map((bucket) => bucket.key));
}

function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
  testID,
}: {
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  testID?: string;
}) {
  const { view, styles, iconSize } = useView();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
    >
      <Icon
        name={icon}
        size={iconSize}
        color={disabled ? view.theme.colors.border : view.theme.colors.foregroundMuted}
      />
    </Pressable>
  );
}

function TextButton({
  label,
  onPress,
  danger = false,
  disabled = false,
  accessibilityLabel,
  testID,
}: {
  label: string;
  onPress(): void;
  danger?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const { styles } = useView();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.textButton, pressed ? styles.pressed : null]}
    >
      <Text style={danger ? styles.dangerLabel : styles.textButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function MoveButtons({
  label,
  testID,
  up,
  down,
  onMove,
}: {
  label: string;
  testID: string;
  up: boolean;
  down: boolean;
  onMove(direction: Direction): void;
}) {
  return (
    <>
      <IconButton
        icon="ArrowUp"
        label={`Move ${label} up`}
        disabled={!up}
        onPress={() => onMove(-1)}
        testID={`${testID}-up`}
      />
      <IconButton
        icon="ArrowDown"
        label={`Move ${label} down`}
        disabled={!down}
        onPress={() => onMove(1)}
        testID={`${testID}-down`}
      />
    </>
  );
}

function InlineEditor({
  label,
  initial,
  placeholder,
  depth,
  suggestions,
  onSubmit,
  testID,
}: {
  label: string;
  initial: string;
  placeholder: string;
  depth: number;
  suggestions?: (value: string) => readonly string[];
  onSubmit(value: string): void;
  testID: string;
}) {
  const { view, styles, setEditor } = useView();
  const [value, setValue] = useState(initial);
  const cancel = () => setEditor(null);
  const matches = suggestions?.(value) ?? NONE;
  return (
    <View style={[styles.editor, { paddingLeft: INDENT + depth * INDENT }]}>
      <TextInput
        autoFocus
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColor={view.theme.colors.foregroundMuted}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={() => onSubmit(value)}
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape") cancel();
        }}
        returnKeyType="done"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        testID={testID}
      />
      {matches.length > 0 ? (
        <View style={styles.strip}>
          {matches.map((path) => (
            <TextButton
              key={path}
              label={path}
              accessibilityLabel={`Use group ${path}`}
              onPress={() => onSubmit(path)}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.strip}>
        <TextButton label="Save" onPress={() => onSubmit(value)} testID={`${testID}-save`} />
        <TextButton label="Cancel" onPress={cancel} />
      </View>
    </View>
  );
}

function ActionStrip({ depth, children }: { depth: number; children: ReactNode }) {
  const { styles } = useView();
  return <View style={[styles.strip, { paddingLeft: INDENT + depth * INDENT }]}>{children}</View>;
}

function GroupRow({ entry }: { entry: GroupEntry }) {
  const ctx = useView();
  const { styles, view, iconSize, actions } = ctx;
  const id = entryId(entry);
  const status = useAggregateStatus(entry.collapsed ? entry.projectKeys : NONE);
  const count = entry.projectKeys.length;
  const countLabel = count === 1 ? "1 project" : `${count} projects`;
  const statusLabel = status ? `, ${STATUS_LABELS[status]}` : "";
  const renaming = ctx.editor?.id === id;
  const moves = ctx.moves.get(id);
  const testID = `project-groups-group-${entry.path}`;
  return (
    <View>
      <View style={[styles.row, { paddingLeft: INDENT + entry.depth * INDENT }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${entry.name}, ${countLabel}${statusLabel}`}
          accessibilityHint={entry.collapsed ? "Expands the group" : "Collapses the group"}
          accessibilityState={{ expanded: !entry.collapsed }}
          aria-expanded={!entry.collapsed}
          accessibilityActions={[{ name: "longpress", label: "Group actions" }]}
          onAccessibilityAction={() => ctx.toggleMenu(id)}
          onPress={() => actions.toggleGroup(entry.path)}
          onLongPress={() => ctx.toggleMenu(id)}
          testID={testID}
          style={({ pressed }) => [styles.rowMain, pressed ? styles.pressed : null]}
        >
          <Icon
            name={entry.collapsed ? "ChevronRight" : "ChevronDown"}
            size={iconSize}
            color={view.theme.colors.foregroundMuted}
          />
          <Icon
            name={entry.collapsed ? "Folder" : "FolderOpen"}
            size={iconSize}
            color={view.theme.colors.foregroundMuted}
          />
          <Text numberOfLines={1} style={styles.groupLabel}>
            {entry.name}
          </Text>
          <View style={styles.spacer} />
          {entry.collapsed ? (
            <>
              <StatusDot status={status} />
              <Text style={styles.detail}>{count}</Text>
            </>
          ) : null}
        </Pressable>
        {ctx.editing ? (
          <MoveButtons
            label={`group ${entry.name}`}
            testID={testID}
            up={moves?.up ?? false}
            down={moves?.down ?? false}
            onMove={(direction) => actions.moveRow(id, direction)}
          />
        ) : null}
      </View>
      {(ctx.editing || ctx.menu === id) && !renaming ? (
        <ActionStrip depth={entry.depth + 1}>
          <TextButton
            label="Rename"
            accessibilityLabel={`Rename group ${entry.name}`}
            onPress={() => ctx.setEditor({ id, kind: "rename-group", initial: entry.path })}
            testID={`${testID}-rename`}
          />
          <TextButton
            label="Ungroup"
            accessibilityLabel={`Ungroup ${entry.name}`}
            onPress={() => actions.ungroup(entry.path)}
            testID={`${testID}-ungroup`}
          />
        </ActionStrip>
      ) : null}
      {renaming ? (
        <InlineEditor
          label={`New name for group ${entry.name}`}
          placeholder="Group, use / to nest"
          initial={entry.path}
          depth={entry.depth + 1}
          onSubmit={(value) => actions.renameGroup(entry.path, value)}
          testID="project-groups-input"
        />
      ) : null}
    </View>
  );
}

function ProjectBlock({ entry, reference }: { entry: ProjectEntry; reference: ProjectRef }) {
  const ctx = useView();
  const { styles, view, iconSize, actions, prefs } = ctx;
  const key = entry.key;
  const id = entryId(entry);
  const collapsed = prefs.collapsedProjects.includes(key);
  const order = prefs.workspaceOrder[key];
  const index = useMemo(() => orderIndex(order ?? NONE), [order]);
  const workspaces = useWorkspaces({
    where: (workspace) =>
      workspace.project.key === key && workspace.pinnedAt === null && !workspace.background,
    orderBy: (a, b) =>
      compareOrdered(
        index,
        a.ref.key,
        b.ref.key,
        compareNames(a.title ?? a.name, b.title ?? b.name) || a.ref.key.localeCompare(b.ref.key),
      ),
  });
  const workspaceKeys = useMemo(() => workspaces.map((workspace) => workspace.key), [workspaces]);
  const status = useAggregateStatus(collapsed ? [key] : NONE);
  const host = ctx.hostLabel(reference.hostId);
  const count = workspaces.length;
  const countLabel = count === 1 ? "1 workspace" : `${count} workspaces`;
  const assigning = ctx.editor?.id === id;
  const moves = ctx.moves.get(id);
  const testID = `project-groups-project-${key}`;
  const openProject = () => view.navigation.openProject(reference);
  return (
    <View>
      <View style={[styles.row, { paddingLeft: INDENT + entry.depth * INDENT }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${entry.label}${host ? ` on ${host}` : ""}, ${countLabel}`}
          accessibilityHint={collapsed ? "Shows the workspaces" : "Hides the workspaces"}
          accessibilityState={{ expanded: !collapsed }}
          aria-expanded={!collapsed}
          accessibilityActions={[{ name: "longpress", label: "Project actions" }]}
          onAccessibilityAction={() => ctx.toggleMenu(id)}
          onPress={() => actions.toggleProject(key)}
          onLongPress={() => ctx.toggleMenu(id)}
          testID={testID}
          style={({ pressed }) => [styles.rowMain, pressed ? styles.pressed : null]}
        >
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            size={iconSize}
            color={view.theme.colors.foregroundMuted}
          />
          <Text numberOfLines={1} style={styles.label} testID={`${testID}-label`}>
            {entry.label}
          </Text>
          {host ? (
            <Text numberOfLines={1} style={styles.detail}>
              {host}
            </Text>
          ) : null}
          <View style={styles.spacer} />
          {collapsed ? (
            <>
              <StatusDot status={status} />
              <Text style={styles.detail}>{count}</Text>
            </>
          ) : null}
        </Pressable>
        {ctx.editing ? (
          <MoveButtons
            label={entry.label}
            testID={testID}
            up={moves?.up ?? false}
            down={moves?.down ?? false}
            onMove={(direction) => actions.moveRow(id, direction)}
          />
        ) : (
          <IconButton
            icon="Plus"
            label={`New workspace in ${entry.label}`}
            onPress={openProject}
            testID={`${testID}-new`}
          />
        )}
      </View>
      {(ctx.editing || ctx.menu === id) && !assigning ? (
        <ActionStrip depth={entry.depth + 1}>
          <TextButton
            label="Move to group"
            accessibilityLabel={`Move ${entry.label} to a group`}
            onPress={() => ctx.setEditor({ id, kind: "assign", initial: ctx.pathOf(key) })}
            testID={`${testID}-assign`}
          />
          {entry.depth > 0 ? (
            <TextButton
              label="Remove from group"
              accessibilityLabel={`Remove ${entry.label} from its group`}
              onPress={() => actions.assign(key, "")}
              testID={`${testID}-ungroup`}
            />
          ) : null}
          {ctx.editing ? (
            <TextButton
              label="New workspace"
              accessibilityLabel={`New workspace in ${entry.label}`}
              onPress={openProject}
            />
          ) : null}
        </ActionStrip>
      ) : null}
      {assigning ? (
        <InlineEditor
          label={`Group for ${entry.label}`}
          placeholder="Group, use / to nest"
          initial={ctx.pathOf(key)}
          depth={entry.depth + 1}
          suggestions={(value) => suggestGroups(ctx.paths, value)}
          onSubmit={(value) => actions.assign(key, value)}
          testID="project-groups-input"
        />
      ) : null}
      {collapsed
        ? null
        : workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.key}
              reference={workspace}
              depth={entry.depth + 1}
              siblings={{ projectKey: key, keys: workspaceKeys }}
            />
          ))}
      {!collapsed && count === 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New workspace in ${entry.label}`}
          onPress={openProject}
          style={({ pressed }) => [
            styles.rowMain,
            { paddingLeft: INDENT + (entry.depth + 1) * INDENT },
            pressed ? styles.pressed : null,
          ]}
        >
          <Icon name="Plus" size={iconSize} color={view.theme.colors.foregroundMuted} />
          <Text style={styles.detail}>New workspace</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function WorkspaceRow({
  reference,
  depth,
  siblings,
}: {
  reference: WorkspaceRef;
  depth: number;
  /** Absent in the pinned section, which follows pin order. */
  siblings?: { projectKey: string; keys: readonly string[] };
}) {
  const ctx = useView();
  const { styles, view, actions } = ctx;
  const paseo = usePaseo();
  const workspace = useWorkspace(reference, (item) => ({
    title: item.title ?? item.name,
    indicator: item.indicator,
    indicatorLabel: item.indicatorLabel,
    pinned: item.pinnedAt !== null,
    archiving: item.archivingAt !== null,
  }));
  const [confirmArchive, setConfirmArchive] = useState(false);
  if (!workspace) return null;
  const id = `workspace:${reference.key}`;
  const active = view.active.workspace?.key === reference.key;
  const renaming = ctx.editor?.id === id;
  const position = siblings ? siblings.keys.indexOf(reference.key) : -1;
  const testID = `project-groups-workspace-${reference.key}`;
  const handle = () => paseo.workspaces.ref(reference);
  const status = workspace.indicatorLabel ? `, ${workspace.indicatorLabel}` : "";
  return (
    <View>
      <View style={[styles.row, { paddingLeft: INDENT + depth * INDENT }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${workspace.title}${status}`}
          accessibilityState={{ selected: active }}
          accessibilityActions={[{ name: "longpress", label: "Workspace actions" }]}
          onAccessibilityAction={() => ctx.toggleMenu(id)}
          onPress={() => view.navigation.openWorkspace(reference)}
          onLongPress={() => ctx.toggleMenu(id)}
          testID={testID}
          style={({ pressed }) => [
            styles.rowMain,
            active ? styles.active : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <StatusDot status={workspace.indicator} />
          <Text numberOfLines={1} style={styles.label}>
            {workspace.title}
          </Text>
          {workspace.archiving ? <Text style={styles.detail}>archiving</Text> : null}
        </Pressable>
        {ctx.editing && siblings ? (
          <MoveButtons
            label={workspace.title}
            testID={testID}
            up={position > 0}
            down={position >= 0 && position < siblings.keys.length - 1}
            onMove={(direction) =>
              actions.moveWorkspace(siblings.projectKey, siblings.keys, reference.key, direction)
            }
          />
        ) : null}
      </View>
      {(ctx.editing || ctx.menu === id) && !renaming ? (
        <ActionStrip depth={depth + 1}>
          <TextButton
            label={workspace.pinned ? "Unpin" : "Pin"}
            accessibilityLabel={`${workspace.pinned ? "Unpin" : "Pin"} ${workspace.title}`}
            onPress={() =>
              actions.run(() => handle().setPinned(!workspace.pinned), "Could not change the pin")
            }
            testID={`${testID}-pin`}
          />
          <TextButton
            label="Rename"
            accessibilityLabel={`Rename ${workspace.title}`}
            onPress={() =>
              ctx.setEditor({ id, kind: "rename-workspace", initial: workspace.title })
            }
          />
          {confirmArchive ? (
            <>
              <TextButton
                label="Confirm archive"
                danger
                accessibilityLabel={`Confirm archiving ${workspace.title}`}
                onPress={() => {
                  setConfirmArchive(false);
                  actions.run(() => handle().archive(), "Could not archive the workspace");
                }}
              />
              <TextButton label="Keep" onPress={() => setConfirmArchive(false)} />
            </>
          ) : (
            <TextButton
              label="Archive"
              danger
              disabled={workspace.archiving}
              accessibilityLabel={`Archive ${workspace.title}`}
              onPress={() => setConfirmArchive(true)}
            />
          )}
        </ActionStrip>
      ) : null}
      {renaming ? (
        <InlineEditor
          label={`New title for ${workspace.title}`}
          placeholder="Workspace title"
          initial={workspace.title}
          depth={depth + 1}
          onSubmit={(value) => {
            ctx.setEditor(null);
            const title = value.trim();
            actions.run(() => handle().setTitle(title || null), "Could not rename the workspace");
          }}
          testID="project-groups-input"
        />
      ) : null}
    </View>
  );
}

function PinnedSection() {
  const { styles } = useView();
  const pinned = useWorkspaces({
    where: (workspace) => workspace.pinnedAt !== null && !workspace.background,
    orderBy: ["pinnedAt", "asc"] as const,
  });
  if (pinned.length === 0) return null;
  return (
    <View testID="project-groups-pinned">
      <Text accessibilityRole="header" style={styles.section}>
        Pinned
      </Text>
      {pinned.map((reference) => (
        <WorkspaceRow key={reference.key} reference={reference} depth={0} />
      ))}
    </View>
  );
}

function toggled(list: readonly string[], item: string): string[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PrefsChange = (values: LayoutPrefs) => LayoutPrefs;

/**
 * Device layout with changes applied at once and saved one at a time: each save starts from the
 * revision the previous one produced, so quick toggles neither conflict nor get lost. A failed
 * save drops its changes and leaves `saveError` on the settings state.
 */
function useSerializedPrefs(state: SettingsState<typeof layoutSettings.schema>) {
  const pending = useRef<PrefsChange[]>([]);
  const inFlight = useRef<PrefsChange[]>([]);
  const [, rerender] = useState(0);
  const ready = state.status === "ready";
  const base = ready ? state.values : DEFAULT_PREFS;
  const prefs = [...inFlight.current, ...pending.current].reduce(
    (values, change) => change(values),
    base,
  );
  useEffect(() => {
    if (state.status !== "ready" || inFlight.current.length > 0 || pending.current.length === 0)
      return;
    const changes = pending.current;
    pending.current = [];
    inFlight.current = changes;
    const next = changes.reduce((values, change) => change(values), state.values);
    void state.save(next, state.revision).finally(() => {
      inFlight.current = [];
      rerender((count) => count + 1);
    });
  });
  const save = useCallback((change: PrefsChange) => {
    pending.current = [...pending.current, change];
    rerender((count) => count + 1);
  }, []);
  return { prefs, save, ready };
}

export function GroupsView(view: PluginSidebarViewProps) {
  const { theme, layout: surface } = view;
  const hosts = useHostGroups();
  const hostSummaries = useHosts();
  const layoutState = useSettings(layoutSettings);
  const { prefs, save: savePrefs, ready: layoutReady } = useSerializedPrefs(layoutState);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const styles = useMemo(() => createStyles(theme, surface.compact), [theme, surface.compact]);

  const projectIndex = useMemo(() => orderIndex(prefs.projectOrder), [prefs.projectOrder]);
  const projectRows = useProjects({
    orderBy: (a, b) =>
      compareOrdered(
        projectIndex,
        a.ref.key,
        b.ref.key,
        compareNames(a.displayName, b.displayName) || a.ref.key.localeCompare(b.ref.key),
      ),
    // One group per project carries its name, so the layout needs no per-project reads.
    groupBy: (project) => ({ key: project.ref.key, title: project.displayName }),
  });
  const refs = useMemo(
    () => new Map(projectRows.map((row) => [row.key, row.items[0]] as const)),
    [projectRows],
  );
  const projects = useMemo<SidebarProject[]>(
    () => projectRows.map((row) => ({ key: row.key, name: row.title ?? "" })),
    [projectRows],
  );
  const ready = useMemo(() => hosts.filter((host) => host.status.status === "ready"), [hosts]);
  const assignments = useMemo<Assignments>(
    () =>
      effectiveAssignments(
        ready,
        Array.from(refs.values(), (ref) => ({ hostId: ref.hostId, projectId: ref.id })),
      ),
    [ready, refs],
  );
  const collapsedGroups = useMemo(() => new Set(prefs.collapsedGroups), [prefs.collapsedGroups]);
  const layout = useMemo(
    () => buildLayout(projects, assignments, collapsedGroups),
    [projects, assignments, collapsedGroups],
  );
  const moves = useMemo(() => siblingMoves(layout), [layout]);
  const paths = useMemo(() => groupPaths(layout), [layout]);

  const run = useCallback((work: () => Promise<unknown>, what: string) => {
    void work().then(
      () => setError(null),
      (failure: unknown) => setError(`${what}: ${errorMessage(failure)}`),
    );
  }, []);

  const writeAssignments = async (next: Assignments) => {
    const writes: AssignmentWrite[] = [];
    for (const [key, ref] of refs) {
      const path = Object.hasOwn(next, key) ? next[key] : undefined;
      const current = Object.hasOwn(assignments, key) ? assignments[key] : undefined;
      if (path !== current) writes.push({ hostId: ref.hostId, projectId: ref.id, path });
    }
    if (writes.length === 0) return;
    const plan = planWrites(ready, writes);
    await Promise.all(
      Array.from(plan, ([hostId, change]) =>
        ready.find((host) => host.hostId === hostId)?.update(change),
      ),
    );
  };

  const close = () => {
    setEditor(null);
    setMenu(null);
  };

  const actions: Actions = {
    toggleGroup: (path) =>
      savePrefs((values) => ({ ...values, collapsedGroups: toggled(values.collapsedGroups, path) })),
    toggleProject: (key) =>
      savePrefs((values) => ({
        ...values,
        collapsedProjects: toggled(values.collapsedProjects, key),
      })),
    assign(key, rawPath) {
      close();
      const project = projects.find((item) => item.key === key);
      if (!project) return;
      run(() => writeAssignments(assignProject(assignments, project, rawPath)), "Could not group");
    },
    renameGroup(from, rawTo) {
      close();
      const to = normalizeGroupPath(rawTo);
      if (!to || to === from) return;
      run(() => writeAssignments(moveGroup(assignments, projects, from, to)), "Could not rename");
      savePrefs((values) => ({
        ...values,
        collapsedGroups: [...moveCollapsed(new Set(values.collapsedGroups), from, to)],
      }));
    },
    ungroup(path) {
      close();
      run(() => writeAssignments(dissolveGroup(assignments, projects, path)), "Could not ungroup");
      savePrefs((values) => ({
        ...values,
        collapsedGroups: [
          ...moveCollapsed(new Set(values.collapsedGroups), path, parentGroupPath(path)),
        ],
      }));
    },
    moveRow(id, direction) {
      const next = moveSibling(layout, id, direction, prefs.projectOrder);
      if (next) savePrefs((values) => ({ ...values, projectOrder: next }));
    },
    moveWorkspace(projectKey, keys, key, direction) {
      const next = moveItem(keys, key, direction);
      if (next)
        savePrefs((values) => ({
          ...values,
          workspaceOrder: { ...values.workspaceOrder, [projectKey]: next },
        }));
    },
    run,
  };

  // Paseo 0.15 assignments move to their projects once the owning hosts' listings are known.
  const migration = useRef<{ running: boolean; failed: string | null }>({
    running: false,
    failed: null,
  });
  useEffect(() => {
    const state = migration.current;
    if (state.running) return;
    // Every registered host must be loaded, so none of them is mistaken for a host without it.
    if (ready.length !== hosts.length) return;
    const plan = planMigration(ready);
    if (!plan) return;
    const fingerprint = JSON.stringify(
      ready.map((host) => [host.hostId, host.doc.legacy, host.doc.appliedLegacy, host.projectKeys]),
    );
    if (state.failed === fingerprint) return;
    state.running = true;
    const byHost = new Map(ready.map((host) => [host.hostId, host]));
    const apply = (changes: typeof plan.writes) =>
      Promise.all(Array.from(changes, ([hostId, change]) => byHost.get(hostId)?.update(change)));
    void apply(plan.writes)
      .then(() => apply(plan.drops))
      .then(
        () => {
          state.failed = null;
        },
        (failure: unknown) => {
          state.failed = fingerprint;
          setError(`Could not move groups from Paseo 0.15: ${errorMessage(failure)}`);
        },
      )
      .finally(() => {
        state.running = false;
      });
  }, [ready]);

  // A project added on a host with unmigrated assignments may be the one a legacy key names.
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  useEffect(() => {
    for (const host of hostsRef.current)
      if (Object.keys(host.doc.legacy).length > 0) void host.refresh();
  }, [projectRows]);

  // Collapsed groups of the 0.15 web version, kept in browser storage, carry over once.
  const imported = useRef(false);
  useEffect(() => {
    if (!layoutReady || prefs.importedWebCollapsed || imported.current) return;
    imported.current = true;
    const legacy = readLegacyCollapsed();
    savePrefs((values) => ({
      ...values,
      collapsedGroups: [...new Set([...values.collapsedGroups, ...legacy])],
      importedWebCollapsed: true,
    }));
  });

  const labels = useMemo(
    () => new Map(hostSummaries.map((host) => [host.serverId, host.label])),
    [hostSummaries],
  );
  const multiHost = useMemo(() => new Set(Array.from(refs.values(), (ref) => ref.hostId)).size > 1, [refs]);

  const context: ViewContextValue = {
    view,
    styles,
    iconSize: surface.compact ? 16 : 14,
    editing,
    menu,
    toggleMenu: (id) => {
      setEditor(null);
      setMenu((current) => (current === id ? null : id));
    },
    editor,
    setEditor,
    prefs,
    paths,
    moves,
    pathOf: (key) => {
      const project = projects.find((item) => item.key === key);
      return project ? placeProject(project, assignments).path : "";
    },
    hostLabel: (hostId) => (multiHost ? (labels.get(hostId) ?? hostId) : null),
    actions,
  };

  const problems = hosts.flatMap((host) =>
    host.status.status === "invalid" || host.status.status === "error"
      ? [{ host, message: host.status.error }]
      : [],
  );

  return (
    <ViewContext.Provider value={context}>
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="project-groups-view"
      >
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={styles.heading}>
            Projects
          </Text>
          <TextButton
            label={editing ? "Done" : "Edit"}
            accessibilityLabel={editing ? "Done editing the sidebar" : "Edit the sidebar"}
            onPress={() => {
              close();
              setEditing((current) => !current);
            }}
            testID="project-groups-edit"
          />
        </View>
        {ready.length === 0 && problems.length === 0 ? (
          <Text style={styles.notice} testID="project-groups-loading">
            Loading groups
          </Text>
        ) : null}
        {problems.map(({ host, message }) => (
          <View key={host.hostId} style={styles.error}>
            <Text style={styles.errorText}>
              Groups on {labels.get(host.hostId) ?? host.hostId}: {message}
            </Text>
            <TextButton label="Retry" onPress={() => void host.refresh()} />
          </View>
        ))}
        {layoutState.status === "invalid" || layoutState.status === "error" ? (
          <View style={styles.error}>
            <Text style={styles.errorText}>Sidebar layout: {layoutState.error}</Text>
            {layoutState.status === "invalid" ? (
              <TextButton label="Reset layout" onPress={() => void layoutState.reset()} />
            ) : (
              <TextButton label="Retry" onPress={() => void layoutState.reload()} />
            )}
          </View>
        ) : null}
        {layoutState.saveError ? (
          <View style={styles.error}>
            <Text style={styles.errorText}>Sidebar layout: {layoutState.saveError}</Text>
          </View>
        ) : null}
        {error ? (
          <View style={styles.error} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{error}</Text>
            <TextButton label="Dismiss" onPress={() => setError(null)} />
          </View>
        ) : null}
        <PinnedSection />
        {layout.map((entry) => {
          if (entry.hidden) return null;
          if (entry.kind === "group") return <GroupRow key={entryId(entry)} entry={entry} />;
          const reference = refs.get(entry.key);
          return reference ? (
            <ProjectBlock key={entryId(entry)} entry={entry} reference={reference} />
          ) : null;
        })}
        {projectRows.length === 0 ? <Text style={styles.notice}>No projects yet</Text> : null}
      </ScrollView>
    </ViewContext.Provider>
  );
}
