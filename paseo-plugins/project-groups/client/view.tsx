// The sidebar view: pinned workspaces, then projects nested in their groups, each with its
// workspaces. Rows navigate with one tap. Like Paseo's own sidebar, a workspace row has a
// one-click archive and a project row has `+` and an actions menu, shown on hover (always on
// touch layouts). Group, rename, pin and order controls also live behind a long press on a row or
// the Edit toggle.

import {
  useHosts,
  useProject,
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
import { copyText, Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Animated,
  Easing,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
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
  workspaceSortTime,
} from "./order.ts";
import { useHostGroups, type HostGroups } from "./registry.ts";
import { compactTimeAgo, nextTimeAgoChange } from "./time.ts";
import {
  ancestorBackground,
  canOpenInNewWindow,
  fileManagerTarget,
  navigateInApp,
  openInFileManager,
  openInNewWindow,
  pointerInside,
  readLegacyCollapsed,
  trackPointer,
} from "./web.ts";

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
  setWorkspaceSort(sort: LayoutPrefs["workspaceSort"]): void;
  run(work: () => Promise<unknown>, what: string): void;
}

interface ViewContextValue {
  view: PluginSidebarViewProps;
  styles: Styles;
  iconSize: number;
  /** Touch layout: row controls stay visible instead of appearing on hover. */
  compact: boolean;
  editor: Editor | null;
  setEditor(editor: Editor | null): void;
  prefs: LayoutPrefs;
  paths: readonly string[];
  moves: ReadonlyMap<string, { up: boolean; down: boolean }>;
  pathOf(key: string): string;
  hostLabel(hostId: string): string | null;
  /** The registry entry of a host that runs this plugin. */
  host(hostId: string): HostGroups | undefined;
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

// Paseo's own sidebar type ramp (`theme.fontSize` at the default UI size: 14 on the desktop and
// web, 15 on phones and tablets). The plugin theme carries colors only, so the sizes live here.
const BASE_FONT = Platform.OS === "web" ? 14 : 15;
const SMALL_FONT = Math.round((12 * BASE_FONT) / 14);
/** Section titles: a step over Paseo's 12pt, which read too small beside the rows. */
const HEADER_FONT = Math.round((13 * BASE_FONT) / 14);
const LINE_HEIGHT = Math.round(BASE_FONT * 1.43);

function createStyles(theme: PluginSidebarViewProps["theme"], compact: boolean) {
  const { colors } = theme;
  // Paseo's density: 36pt rows and 24pt row buttons with a pointer, touch targets otherwise.
  const rowHeight = compact ? 44 : 36;
  const control = compact ? 36 : 24;
  return StyleSheet.create({
    // Rows are controls: no text selection on a drag or a double click, as in Paseo's sidebar.
    root: { flex: 1, userSelect: "none" },
    content: { paddingHorizontal: 8, paddingBottom: 12 },
    // A section header row ("Pinned", "Projects"): a row's height, its title a step under the
    // rows' text, and a 28pt button (a touch target on touch layouts) at the trailing edge.
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: rowHeight,
      paddingLeft: 8,
      paddingRight: 4,
      gap: 8,
    },
    sectionTitle: { flex: 1, color: colors.foregroundMuted, fontSize: HEADER_FONT },
    headerButton: {
      width: compact ? 36 : 28,
      height: compact ? 36 : 28,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 6,
    },
    // The gap that separates the pinned section from the projects, as in Paseo's sidebar.
    pinnedSection: { marginBottom: 8 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: rowHeight,
      marginBottom: 2,
      paddingRight: 4,
      borderRadius: 8,
      gap: 2,
    },
    rowHovered: { backgroundColor: colors.surface1 },
    // Paseo's workspace timestamp: small, the quietest text on the row.
    time: { flexShrink: 0, color: colors.foregroundMuted, opacity: 0.8, fontSize: SMALL_FONT, paddingRight: 4 },
    rowMain: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "stretch",
      gap: 8,
      minWidth: 0,
    },
    pressed: { backgroundColor: colors.surface2 },
    active: { backgroundColor: colors.surface2 },
    label: {
      flexShrink: 1,
      color: colors.foreground,
      fontSize: BASE_FONT,
      lineHeight: LINE_HEIGHT,
    },
    projectLabel: {
      flexShrink: 1,
      color: colors.foregroundMuted,
      fontSize: BASE_FONT,
      lineHeight: LINE_HEIGHT,
    },
    groupLabel: {
      flexShrink: 1,
      color: colors.foreground,
      fontSize: BASE_FONT,
      lineHeight: LINE_HEIGHT,
      fontWeight: "600",
    },
    spacer: { flex: 1 },
    detail: { color: colors.foregroundMuted, fontSize: SMALL_FONT },
    dot: { width: 8, height: 8, borderRadius: 4 },
    dotSlot: { width: compact ? 20 : 16, alignItems: "center", justifyContent: "center" },
    button: {
      width: control,
      height: control,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 6,
    },
    textButton: {
      minHeight: control,
      paddingHorizontal: 10,
      justifyContent: "center",
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    textButtonLabel: { color: colors.foreground, fontSize: SMALL_FONT },
    dangerLabel: { color: colors.statusDanger, fontSize: SMALL_FONT },
    strip: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingRight: 8, paddingVertical: 4 },
    editor: { gap: 6, paddingRight: 8, paddingVertical: 4 },
    input: {
      color: colors.foreground,
      fontSize: BASE_FONT,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: compact ? 10 : 6,
    },
    notice: { color: colors.foregroundMuted, fontSize: SMALL_FONT, paddingHorizontal: 8, paddingVertical: 4 },
    error: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    errorText: { flexShrink: 1, color: colors.statusDanger, fontSize: SMALL_FONT },
    menuBackdrop: { flex: 1 },
    menuSheetRoot: { flex: 1, justifyContent: "flex-end" },
    menuSheetDim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.4)" },
    // A menu renders in a portal outside the view, so it repeats the view's `userSelect`.
    menu: {
      userSelect: "none",
      position: "absolute",
      width: 230,
      paddingVertical: 4,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    sheet: {
      userSelect: "none",
      paddingTop: 8,
      paddingBottom: 24,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      backgroundColor: colors.surface1,
    },
    sheetTitle: {
      color: colors.foregroundMuted,
      fontSize: SMALL_FONT,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: compact ? 48 : 32,
      paddingHorizontal: compact ? 16 : 10,
      marginHorizontal: compact ? 0 : 4,
      borderRadius: 6,
    },
    menuItemLabel: { flexShrink: 1, color: colors.foreground, fontSize: BASE_FONT },
    menuItemDanger: { flexShrink: 1, color: colors.statusDanger, fontSize: BASE_FONT },
    menuSeparator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical: 4,
    },
    menuMessage: {
      color: colors.foreground,
      fontSize: SMALL_FONT,
      lineHeight: Math.round(SMALL_FONT * 1.45),
      paddingHorizontal: compact ? 16 : 12,
      paddingVertical: 8,
    },
    menuActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 6,
      paddingHorizontal: compact ? 16 : 10,
      paddingBottom: 6,
    },
    menuField: { paddingHorizontal: compact ? 16 : 8, paddingVertical: 6 },
    // Paseo's sidebar leading slot: an `md` icon box as tall as the title's line.
    markSlot: {
      width: compact ? 20 : 16,
      height: LINE_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
    },
    markDot: { width: 6, height: 6, borderRadius: 3 },
    idleDot: { opacity: 0.3 },
    failedDot: {
      position: "absolute",
      right: compact ? 0 : -1,
      bottom: 2,
      width: 8,
      height: 8,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: colors.surface0,
    },
    projectIcon: { alignItems: "center", justifyContent: "center" },
    projectIconText: { color: "#ffffff", fontSize: compact ? 11 : 9, fontWeight: "600" },
    // The running ring: a 6pt dot inside a 12pt ring of 1.5pt stroke, its top quarter turning.
    ringFrame: { width: 12, height: 12, alignItems: "center", justifyContent: "center" },
    ringTrack: {
      position: "absolute",
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: statusDotColors(theme).running,
      opacity: 0.3,
    },
    ringArc: {
      position: "absolute",
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: "transparent",
      borderTopColor: statusDotColors(theme).running,
      opacity: 0.9,
    },
    ringDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: statusDotColors(theme).running },
  });
}

type Styles = ReturnType<typeof createStyles>;

interface StatusDotColors {
  needs_input: string;
  failed: string;
  running: string;
  attention: string;
}

// Paseo's status dot band (`statusDot*` in its theme), louder than the plugin theme's status
// colors and with a blue for running. The plugin theme doesn't carry it, so the scheme is read
// from the surface's lightness.
const LIGHT_STATUS_DOTS: StatusDotColors = {
  needs_input: "#b37824",
  failed: "#f12e2f",
  running: "#268ae0",
  attention: "#299f51",
};
const DARK_STATUS_DOTS: StatusDotColors = {
  needs_input: "#db932e",
  failed: "#f7796d",
  running: "#5caaf6",
  attention: "#35c264",
};

/** `surface0` as RGB, or null when it isn't a `#rrggbb` color. */
function surfaceRgb(theme: PluginSidebarViewProps["theme"]): [number, number, number] | null {
  const hex = /^#?([0-9a-f]{6})/i.exec(theme.colors.surface0)?.[1];
  if (!hex) return null;
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return [r, g, b];
}

function isLight(rgb: readonly [number, number, number]): boolean {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 128;
}

function statusDotColors(theme: PluginSidebarViewProps["theme"]): StatusDotColors {
  const rgb = surfaceRgb(theme);
  return rgb && isLight(rgb) ? LIGHT_STATUS_DOTS : DARK_STATUS_DOTS;
}

/**
 * Paseo's sidebar background (`surfaceSidebar`), which the plugin theme doesn't carry, for the
 * sticky header's backdrop where the page can't be read (native). Paseo's light themes use
 * `surface2`, its dark ones a shade under `surface0`.
 */
function estimatedSidebarBackground(theme: PluginSidebarViewProps["theme"]): string {
  const rgb = surfaceRgb(theme);
  if (!rgb) return theme.colors.surface0;
  if (isLight(rgb)) return theme.colors.surface2;
  return `rgb(${rgb.map((channel) => Math.round(channel * 0.82)).join(", ")})`;
}

function indicatorColor(
  theme: PluginSidebarViewProps["theme"],
  status: StatusBucket | WorkspaceIndicator | null,
): string | null {
  return status === null || status === "done" ? null : statusDotColors(theme)[status];
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

/** Left padding of a row at `depth`. */
function indent(depth: number): number {
  return 4 + depth * INDENT;
}

interface HoverProps {
  onPointerEnter(): void;
  onPointerLeave(): void;
}

/**
 * Hover over a whole row, buttons included: its props go on the row's own `View`, as in
 * Paseo's sidebar (a nested `Pressable` doesn't pass hover up to an outer one).
 *
 * An open menu covers the row, so the browser reports the pointer leaving it, and once the menu
 * closes it reports nothing until the pointer moves again. The row stays hovered while its menu
 * is open, and on close it is hovered if the pointer's last position is still inside it; reading
 * the leave as is made the row's buttons and its chevron blink off and back.
 */
function useRowHover(menu: RowMenu): [boolean, HoverProps] {
  const [hovered, setHovered] = useState(false);
  const open = menu.placement !== null;
  const openRef = useRef(open);
  openRef.current = open;
  const props = useMemo<HoverProps>(
    () => ({
      onPointerEnter: () => {
        trackPointer();
        setHovered(true);
      },
      onPointerLeave: () => {
        if (!openRef.current) setHovered(false);
      },
    }),
    [],
  );
  const wasOpen = useRef(false);
  const row = menu.row;
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    setHovered(pointerInside(row.current));
  }, [open, row]);
  return [hovered, props];
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
  onPress(event: GestureResponderEvent): void;
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

/** Whether the section a row sits in (pinned, or the projects) is in edit mode. */
const EditingContext = createContext(false);

/**
 * A section's header row, as Paseo's "Pinned" and "Workspaces": the title and, at the trailing
 * edge, its buttons. A sticky header paints the sidebar's background behind it, read from the
 * page on the web and estimated on native.
 */
function SectionHeader({
  title,
  sticky = false,
  testID,
  children,
}: {
  title: string;
  sticky?: boolean;
  testID: string;
  children: ReactNode;
}) {
  const { view, styles } = useView();
  const header = useRef<View>(null);
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const surface = view.theme.colors.surface0;
  useLayoutEffect(() => {
    if (sticky) setBackdrop(ancestorBackground(header.current));
  }, [sticky, surface]);
  return (
    <View
      ref={header}
      style={[
        styles.sectionHeader,
        sticky ? { backgroundColor: backdrop ?? estimatedSidebarBackground(view.theme) } : null,
      ]}
      testID={testID}
    >
      <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Paseo's section header button: a 14pt glyph in a 28pt square (a touch target on touch). */
function HeaderButton({
  icon,
  label,
  onPress,
  active = false,
  buttonRef,
  testID,
}: {
  icon: string;
  label: string;
  onPress(): void;
  /** Edit mode on, or its menu open. */
  active?: boolean;
  buttonRef?: RefObject<View | null>;
  testID: string;
}) {
  const { view, styles } = useView();
  return (
    <Pressable
      ref={buttonRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={4}
      onPress={onPress}
      testID={testID}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.headerButton,
        pressed || hovered || active ? styles.pressed : null,
      ]}
    >
      <Icon name={icon} size={14} color={view.theme.colors.foregroundMuted} />
    </Pressable>
  );
}

type WorkspaceSort = LayoutPrefs["workspaceSort"];

const WORKSPACE_SORTS: readonly { sort: WorkspaceSort; label: string; icon: string }[] = [
  { sort: "manual", label: "Manual", icon: "ListOrdered" },
  { sort: "created", label: "Created", icon: "CalendarPlus" },
  { sort: "lastPrompt", label: "Last prompt", icon: "MessageSquare" },
];

/**
 * The Projects header's display menu, behind Paseo's sliders button: the workspace sort (a page
 * of its own, as in Paseo's menu) and the way into edit mode. While editing, a check mark in its
 * place leaves edit mode.
 */
function ProjectsHeaderActions({
  editing,
  onToggleEditing,
}: {
  editing: boolean;
  onToggleEditing(): void;
}) {
  const { prefs, actions } = useView();
  const menu = useRowMenu();
  const [page, setPage] = useState<"root" | "sort">("root");
  if (editing) {
    return (
      <HeaderButton
        icon="Check"
        label="Done editing groups"
        active
        onPress={onToggleEditing}
        testID="project-groups-projects-header-edit"
      />
    );
  }
  const current = WORKSPACE_SORTS.find((item) => item.sort === prefs.workspaceSort);
  const entries: MenuEntry[] =
    page === "root"
      ? [
          {
            key: "sort",
            label: "Sort",
            detail: current?.label,
            icon: "ArrowDownUp",
            keepOpen: true,
            onSelect: () => setPage("sort"),
            testID: "project-groups-sort",
          },
          "separator",
          {
            key: "edit",
            label: "Edit groups and order",
            icon: "Pencil",
            onSelect: onToggleEditing,
            testID: "project-groups-projects-header-edit",
          },
        ]
      : [
          {
            key: "back",
            label: "Sort",
            icon: "ChevronLeft",
            keepOpen: true,
            onSelect: () => setPage("root"),
          },
          "separator",
          ...WORKSPACE_SORTS.map(({ sort, label, icon }) => ({
            key: sort,
            label,
            icon,
            checked: prefs.workspaceSort === sort,
            onSelect: () => actions.setWorkspaceSort(sort),
            testID: `project-groups-sort-${sort}`,
          })),
        ];
  return (
    <>
      <HeaderButton
        icon="Settings2"
        label="Display preferences"
        active={menu.placement !== null}
        buttonRef={menu.trigger}
        onPress={menu.openAtTrigger}
        testID="project-groups-projects-header-menu"
      />
      <ActionMenu
        title="Display preferences"
        menu={menu}
        entries={entries}
        onClose={() => {
          menu.close();
          setPage("root");
        }}
        testID="project-groups-projects-menu"
      />
    </>
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

interface MenuItem {
  key: string;
  label: string;
  icon: string;
  danger?: boolean;
  /** A value after the label with a chevron, for an item that opens a page ("Sort  Manual >"). */
  detail?: string;
  /** Shows a check after the label (a label assigned to the workspace). */
  checked?: boolean;
  /** The item swaps the menu's content instead of closing it. */
  keepOpen?: boolean;
  testID?: string;
  onSelect(): void;
}

type MenuEntry = MenuItem | "separator";

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a menu opens: under its `⋮` trigger, right-aligned, or at the pointer for a right-click. */
interface MenuPlacement {
  anchor: Anchor;
  align: "start" | "end";
}

const MENU_WIDTH = 230;

/** The window point of a right-click or long press. */
function eventPoint(event: unknown): Anchor | null {
  const source =
    event && typeof event === "object" && "nativeEvent" in event
      ? Reflect.get(event, "nativeEvent")
      : event;
  if (!source || typeof source !== "object") return null;
  const x: unknown = Reflect.get(source, "pageX") ?? Reflect.get(source, "clientX");
  const y: unknown = Reflect.get(source, "pageY") ?? Reflect.get(source, "clientY");
  return typeof x === "number" && typeof y === "number" ? { x, y, width: 0, height: 0 } : null;
}

interface RowMenu {
  placement: MenuPlacement | null;
  /** The row, for a menu opened without a pointer (an accessibility action). */
  row: RefObject<View | null>;
  trigger: RefObject<View | null>;
  openAtTrigger(): void;
  /** Right-click on the web, long press on touch: the menu opens where the row was pressed. */
  openAtEvent(event: unknown): void;
  /** Props for the row's pressable: right-click (web), long press, and the accessibility action. */
  pressProps: object;
  close(): void;
}

function useRowMenu(): RowMenu {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const row = useRef<View>(null);
  const trigger = useRef<View>(null);
  const measure = (target: RefObject<View | null>) =>
    target.current?.measureInWindow((x, y, width, height) =>
      setPlacement({ anchor: { x, y, width, height }, align: "end" }),
    );
  const openAtEvent = (event: unknown) => {
    const point = eventPoint(event);
    if (point) setPlacement({ anchor: point, align: "start" });
    else measure(row);
  };
  const pressProps = {
    onLongPress: openAtEvent,
    accessibilityActions: [{ name: "longpress", label: "Actions" }],
    onAccessibilityAction: () => measure(row),
    // react-native-web passes `onContextMenu` through to the element; it isn't in RN's types.
    ...(Platform.OS === "web"
      ? {
          onContextMenu: (event: { preventDefault?(): void; stopPropagation?(): void }) => {
            event.preventDefault?.();
            event.stopPropagation?.();
            openAtEvent(event);
          },
        }
      : {}),
  };
  return {
    placement,
    row,
    trigger,
    openAtTrigger: () => measure(trigger),
    openAtEvent,
    pressProps,
    close: () => setPlacement(null),
  };
}

/**
 * A dropdown at its trigger or the pointer with a pointer, a bottom sheet on touch layouts, as
 * Paseo's own menus. Pressing outside or Escape closes it. `panel` replaces the items, for a
 * confirmation or the labels list.
 */
function ActionMenu({
  title,
  menu,
  entries,
  panel,
  onClose,
  testID,
}: {
  title: string;
  menu: RowMenu;
  entries: readonly MenuEntry[];
  panel?: ReactNode;
  onClose(): void;
  testID?: string;
}) {
  // A fresh surface per opening, so it measures itself again before it shows.
  return menu.placement ? (
    <MenuSurface
      title={title}
      placement={menu.placement}
      entries={entries}
      panel={panel}
      onClose={onClose}
      testID={testID}
    />
  ) : null;
}

function MenuSurface({
  title,
  placement,
  entries,
  panel,
  onClose,
  testID,
}: {
  title: string;
  placement: MenuPlacement;
  entries: readonly MenuEntry[];
  panel?: ReactNode;
  onClose(): void;
  testID?: string;
}) {
  const { styles, view, iconSize, compact } = useView();
  const window = useWindowDimensions();
  // Hidden until laid out, so a dropdown that flips above its trigger doesn't show first below it.
  const [height, setHeight] = useState<number | null>(null);
  // Paseo's menu motion: a dropdown fades and scales in from 97% over 150ms; the phone sheet
  // slides up over a fading dim, and back down before it closes.
  const progress = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  const measured = height !== null;
  useEffect(() => {
    if (!measured) return;
    Animated.timing(progress, {
      toValue: 1,
      duration: compact ? 220 : 150,
      easing: compact ? Easing.out(Easing.cubic) : Easing.linear,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [compact, measured, progress]);
  const dismiss = () => {
    if (!compact) return onClose();
    if (closing.current) return;
    closing.current = true;
    Animated.timing(progress, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    }).start(() => onClose());
  };
  const { anchor } = placement;
  const preferred = placement.align === "end" ? anchor.x + anchor.width - MENU_WIDTH : anchor.x;
  const left = Math.max(8, Math.min(preferred, window.width - MENU_WIDTH - 8));
  const below = anchor.y + anchor.height + 4;
  const menuHeight = height ?? 0;
  const above = below + menuHeight > window.height - 8;
  const top = above ? Math.max(8, anchor.y - menuHeight - 4) : below;
  const onLayout = (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height);
  const body =
    panel ??
    entries.map((entry, index) =>
      entry === "separator" ? (
        <View key={`separator-${index}`} style={styles.menuSeparator} />
      ) : (
        <Pressable
          key={entry.key}
          accessibilityRole="menuitem"
          accessibilityLabel={entry.label}
          accessibilityState={entry.checked === undefined ? undefined : { checked: entry.checked }}
          onPress={() => {
            if (!entry.keepOpen) dismiss();
            entry.onSelect();
          }}
          testID={entry.testID}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.menuItem,
            pressed || hovered ? styles.pressed : null,
          ]}
        >
          <Icon
            name={entry.icon}
            size={iconSize}
            color={entry.danger ? view.theme.colors.statusDanger : view.theme.colors.foregroundMuted}
          />
          <Text numberOfLines={1} style={entry.danger ? styles.menuItemDanger : styles.menuItemLabel}>
            {entry.label}
          </Text>
          {entry.checked ? (
            <>
              <View style={styles.spacer} />
              <Icon name="Check" size={iconSize} color={view.theme.colors.foreground} />
            </>
          ) : null}
          {entry.detail !== undefined ? (
            <>
              <View style={styles.spacer} />
              <Text numberOfLines={1} style={styles.detail}>
                {entry.detail}
              </Text>
              <Icon name="ChevronRight" size={iconSize} color={view.theme.colors.foregroundMuted} />
            </>
          ) : null}
        </Pressable>
      ),
    );
  const surface = (
    <Pressable
      accessibilityRole="menu"
      accessibilityLabel={title}
      onPress={() => undefined}
      onLayout={compact ? onLayout : undefined}
      style={compact ? styles.sheet : undefined}
      testID={testID}
    >
      {compact ? <Text style={styles.sheetTitle}>{title}</Text> : null}
      {body}
    </Pressable>
  );
  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={dismiss}
      // As Paseo's own menus do on Android: React Native lays a modal's first frames out at the
      // screen minus the system bars, then grows it to the window, so a bottom sheet shows high
      // and snaps down. The app draws edge to edge; size the content to the window from the start.
      statusBarTranslucent={Platform.OS === "android"}
      style={
        Platform.OS === "android" ? { flex: 0, width: window.width, height: window.height } : undefined
      }
    >
      {compact ? (
        <View style={styles.menuSheetRoot}>
          <Animated.View style={[styles.menuSheetDim, { opacity: progress }]}>
            <Pressable accessibilityLabel="Close menu" onPress={dismiss} style={styles.menuBackdrop} />
          </Animated.View>
          <Animated.View
            style={{
              transform: [
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [height ?? window.height, 0],
                  }),
                },
              ],
            }}
          >
            {surface}
          </Animated.View>
        </View>
      ) : (
        <Pressable
          accessibilityLabel="Close menu"
          onPress={onClose}
          style={styles.menuBackdrop}
          {...(Platform.OS === "web" ? { onContextMenu: onClose } : {})}
        >
          <Animated.View
            onLayout={onLayout}
            style={[
              styles.menu,
              {
                left,
                top,
                opacity: progress,
                transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
                transformOrigin: `${above ? "bottom" : "top"} ${placement.align === "end" ? "right" : "left"}`,
              },
            ]}
          >
            {surface}
          </Animated.View>
        </Pressable>
      )}
    </Modal>
  );
}

/** A row's `⋮` button. */
function MenuTrigger({ label, menu, testID }: { label: string; menu: RowMenu; testID: string }) {
  const { styles, view, iconSize } = useView();
  const open = menu.placement !== null;
  return (
    <Pressable
      ref={menu.trigger}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      hitSlop={4}
      onPress={menu.openAtTrigger}
      testID={testID}
      style={({ pressed }) => [styles.button, pressed || open ? styles.pressed : null]}
    >
      <Icon name="EllipsisVertical" size={iconSize} color={view.theme.colors.foregroundMuted} />
    </Pressable>
  );
}

/** A menu's question with Cancel and a danger button, in place of its items. */
function ConfirmPanel({
  message,
  confirmLabel,
  onCancel,
  onConfirm,
  testID,
}: {
  message: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
  testID: string;
}) {
  const { styles } = useView();
  return (
    <>
      <Text style={styles.menuMessage}>{message}</Text>
      <View style={styles.menuActions}>
        <TextButton label="Cancel" onPress={onCancel} />
        <TextButton label={confirmLabel} danger onPress={onConfirm} testID={testID} />
      </View>
    </>
  );
}

/** The labels of one workspace: every label of its host, assigned ones checked, and a new one. */
function LabelsPanel({
  reference,
  assigned,
  onBack,
}: {
  reference: WorkspaceRef;
  assigned: readonly string[];
  onBack(): void;
}) {
  const { styles, view, iconSize, actions } = useView();
  const paseo = usePaseo();
  const [draft, setDraft] = useState("");
  const groups = useWorkspaces({ hosts: [reference.hostId], groupBy: (item) => item.labels });
  // A label unassigned from its last workspace stays listed while the panel is open.
  const seen = useRef(new Set<string>());
  for (const name of [...groups.map((group) => group.key), ...assigned]) seen.current.add(name);
  const names = [...seen.current].sort(compareNames);
  const setLabel = (name: string, on: boolean) =>
    actions.run(
      () => paseo.workspaces.ref(reference).setLabel(name, { assigned: on }),
      "Could not change the label",
    );
  return (
    <View testID="project-groups-labels">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to workspace actions"
        onPress={onBack}
        style={({ pressed }) => [styles.menuItem, pressed ? styles.pressed : null]}
      >
        <Icon name="ChevronLeft" size={iconSize} color={view.theme.colors.foregroundMuted} />
        <Text style={styles.menuItemLabel}>Labels</Text>
      </Pressable>
      <View style={styles.menuSeparator} />
      {names.map((name) => {
        const on = assigned.includes(name);
        return (
          <Pressable
            key={name}
            accessibilityRole="menuitem"
            accessibilityLabel={name}
            accessibilityState={{ checked: on }}
            onPress={() => setLabel(name, !on)}
            style={({ pressed }) => [styles.menuItem, pressed ? styles.pressed : null]}
          >
            <Icon name="Tag" size={iconSize} color={view.theme.colors.foregroundMuted} />
            <Text numberOfLines={1} style={styles.menuItemLabel}>
              {name}
            </Text>
            <View style={styles.spacer} />
            {on ? <Icon name="Check" size={iconSize} color={view.theme.colors.foreground} /> : null}
          </Pressable>
        );
      })}
      <View style={styles.menuField}>
        <TextInput
          accessibilityLabel="New label"
          placeholder="New label"
          placeholderTextColor={view.theme.colors.foregroundMuted}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => {
            const name = draft.trim();
            if (!name) return;
            setDraft("");
            setLabel(name, true);
          }}
          returnKeyType="done"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          testID="project-groups-label-input"
        />
      </View>
    </View>
  );
}

// Paseo's generated project icon: its ten muted identity colors, picked by a hash of the
// project's key, under a white initial (`styles/identity-colors.ts` in Paseo's app).
const IDENTITY_COLORS = [
  "#7a6aa8",
  "#3d7ea6",
  "#388068",
  "#a4673a",
  "#b05c80",
  "#6a70b8",
  "#368080",
  "#b06260",
  "#8f7838",
  "#5179b0",
];

function identityColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length];
}

/** The project's own icon from its host, or Paseo's lettered square while there is none. */
function ProjectIcon({ reference, name }: { reference: ProjectRef; name: string }) {
  const { styles, compact, host } = useView();
  const owner = host(reference.hostId);
  const revision = useProject(reference, (project) => ({ revision: project.iconRevision }))?.revision;
  const icon = useQuery({
    queryKey: ["project-groups", "icon", reference.key, revision ?? null],
    queryFn: () => owner?.projectIcon(reference.id) ?? null,
    enabled: owner !== undefined,
    staleTime: Infinity,
    retry: false,
  });
  const size = compact ? 20 : 16;
  if (icon.data) return <Image source={{ uri: icon.data }} style={{ width: size, height: size }} />;
  // Paseo colors by the project's shared key when there is one, as its sidebar does.
  const colorKey = owner?.projectKeys?.[reference.id] ?? reference.key;
  const initial = (name.split("/").filter(Boolean).pop() ?? name).charAt(0).toUpperCase();
  return (
    <View
      style={[
        styles.projectIcon,
        { width: size, height: size, borderRadius: Math.round(size * 0.25) },
        { backgroundColor: identityColor(colorKey) },
      ]}
    >
      <Text style={styles.projectIconText}>{initial}</Text>
    </View>
  );
}

/** Paseo's running mark: a quarter arc turning on a faint ring around a dot. */
function RunningRing() {
  const { styles } = useView();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <View style={styles.ringFrame}>
      <View style={styles.ringTrack} />
      <Animated.View style={[styles.ringArc, { transform: [{ rotate }] }]} />
      <View style={styles.ringDot} />
    </View>
  );
}

/**
 * A workspace's last interaction ("5m", "2d", "Oct 28"). Its own component, so the clock
 * re-renders one `Text`; it wakes only when the label can change, and never once it is a date.
 */
function WorkspaceTime({ at }: { at: string }) {
  const { styles } = useView();
  const [now, setNow] = useState(() => new Date());
  const date = new Date(at);
  const wait = nextTimeAgoChange(date, now);
  useEffect(() => {
    if (wait === null) return undefined;
    const timer = setTimeout(() => setNow(new Date()), wait + 50);
    return () => clearTimeout(timer);
  }, [wait, now]);
  return (
    <Text numberOfLines={1} style={styles.time} testID="project-groups-workspace-time">
      {compactTimeAgo(date, now)}
    </Text>
  );
}

/**
 * A workspace's leading mark, as in Paseo's sidebar: the turning ring while it runs, an alert
 * when it needs input, a dot when it is ready to review, a faint dot when idle, and its kind
 * (local checkout, worktree, folder) with a red dot when it failed.
 */
function WorkspaceMark({
  indicator,
  kind,
}: {
  indicator: WorkspaceIndicator;
  kind: "directory" | "local_checkout" | "checkout" | "worktree";
}) {
  const { styles, view } = useView();
  const { colors } = view.theme;
  const dots = statusDotColors(view.theme);
  let mark: ReactNode;
  if (indicator === "running") mark = <RunningRing />;
  else if (indicator === "needs_input")
    mark = <Icon name="CircleAlert" size={12} color={dots.needs_input} />;
  else if (indicator === "attention")
    mark = <View style={[styles.markDot, { backgroundColor: dots.attention }]} />;
  else if (indicator === "done")
    mark = <View style={[styles.markDot, styles.idleDot, { backgroundColor: colors.foregroundMuted }]} />;
  else
    mark = (
      <>
        <Icon
          name={kind === "local_checkout" ? "Monitor" : kind === "worktree" ? "FolderGit2" : "Folder"}
          size={14}
          color={colors.foregroundMuted}
        />
        <View style={[styles.failedDot, { backgroundColor: dots.failed }]} />
      </>
    );
  return <View style={styles.markSlot}>{mark}</View>;
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
    <View style={[styles.editor, { paddingLeft: indent(depth) }]}>
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
  return <View style={[styles.strip, { paddingLeft: indent(depth) }]}>{children}</View>;
}

function GroupRow({ entry }: { entry: GroupEntry }) {
  const ctx = useView();
  const editing = useContext(EditingContext);
  const { styles, view, iconSize, actions } = ctx;
  const menu = useRowMenu();
  const [hovered, hover] = useRowHover(menu);
  const id = entryId(entry);
  const status = useAggregateStatus(entry.collapsed ? entry.projectKeys : NONE);
  const count = entry.projectKeys.length;
  const countLabel = count === 1 ? "1 project" : `${count} projects`;
  const statusLabel = status ? `, ${STATUS_LABELS[status]}` : "";
  const renaming = ctx.editor?.id === id;
  const moves = ctx.moves.get(id);
  const testID = `project-groups-group-${entry.path}`;
  const rename = () => ctx.setEditor({ id, kind: "rename-group", initial: entry.path });
  const entries: MenuEntry[] = [
    { key: "rename", label: "Rename group", icon: "Pencil", testID: `${testID}-menu-rename`, onSelect: rename },
    {
      key: "ungroup",
      label: "Ungroup",
      icon: "FolderOutput",
      testID: `${testID}-menu-ungroup`,
      onSelect: () => actions.ungroup(entry.path),
    },
  ];
  return (
    <View>
      <View
        ref={menu.row}
        {...hover}
        style={[
          styles.row,
          { paddingLeft: indent(entry.depth) },
          hovered || menu.placement ? styles.rowHovered : null,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${entry.name}, ${countLabel}${statusLabel}`}
          accessibilityHint={entry.collapsed ? "Expands the group" : "Collapses the group"}
          accessibilityState={{ expanded: !entry.collapsed }}
          aria-expanded={!entry.collapsed}
          onPress={() => actions.toggleGroup(entry.path)}
          testID={testID}
          style={styles.rowMain}
          {...menu.pressProps}
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
        {editing ? (
          <MoveButtons
            label={`group ${entry.name}`}
            testID={testID}
            up={moves?.up ?? false}
            down={moves?.down ?? false}
            onMove={(direction) => actions.moveRow(id, direction)}
          />
        ) : null}
      </View>
      <ActionMenu
        title={`Actions for group ${entry.name}`}
        menu={menu}
        entries={entries}
        onClose={menu.close}
        testID={`${testID}-menu`}
      />
      {editing && !renaming ? (
        <ActionStrip depth={entry.depth + 1}>
          <TextButton
            label="Rename"
            accessibilityLabel={`Rename group ${entry.name}`}
            onPress={rename}
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

/** The desktop app's file-manager target for `path`, asked once a menu opens. */
function useFolderTarget(open: boolean, path: string | null | undefined): string | null {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !path) return;
    let current = true;
    fileManagerTarget(path).then(
      (found) => {
        if (current) setTarget(found);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open, path]);
  return target;
}

function ProjectBlock({ entry, reference }: { entry: ProjectEntry; reference: ProjectRef }) {
  const ctx = useView();
  const editing = useContext(EditingContext);
  const { styles, view, iconSize, actions, prefs } = ctx;
  const menu = useRowMenu();
  const [hovered, hover] = useRowHover(menu);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const project = useProject(reference, (item) => ({
    rootPath: item.rootPath,
    displayName: item.displayName,
  }));
  const rootPath = project?.rootPath;
  const folderTarget = useFolderTarget(menu.placement !== null, rootPath);
  const key = entry.key;
  const id = entryId(entry);
  const collapsed = prefs.collapsedProjects.includes(key);
  const order = prefs.workspaceOrder[key];
  const sort = prefs.workspaceSort;
  const index = useMemo(() => orderIndex(order ?? NONE), [order]);
  const workspaces = useWorkspaces({
    where: (workspace) =>
      workspace.project.key === key && workspace.pinnedAt === null && !workspace.background,
    orderBy: (a, b) =>
      sort === "manual"
        ? compareOrdered(
            index,
            a.ref.key,
            b.ref.key,
            compareNames(a.title ?? a.name, b.title ?? b.name) || a.ref.key.localeCompare(b.ref.key),
          )
        : workspaceSortTime(b, sort) - workspaceSortTime(a, sort) ||
          a.ref.key.localeCompare(b.ref.key),
  });
  const workspaceKeys = useMemo(() => workspaces.map((workspace) => workspace.key), [workspaces]);
  const status = useAggregateStatus(collapsed ? [key] : NONE);
  const host = ctx.hostLabel(reference.hostId);
  const owner = ctx.host(reference.hostId);
  const count = workspaces.length;
  const countLabel = count === 1 ? "1 workspace" : `${count} workspaces`;
  const assigning = ctx.editor?.id === id;
  const moves = ctx.moves.get(id);
  const testID = `project-groups-project-${key}`;
  const openProject = () => view.navigation.openProject(reference);
  const closeMenu = () => {
    menu.close();
    setConfirmRemove(false);
  };

  const entries: MenuEntry[] = [
    {
      key: "settings",
      label: "Open project settings",
      icon: "Settings",
      testID: `${testID}-menu-settings`,
      onSelect: () => {
        const route = `/settings/hosts/${encodeURIComponent(reference.hostId)}/projects/${encodeURIComponent(reference.id)}`;
        // In this window on the web and desktop, through the app's own link on phones.
        if (!navigateInApp(route)) void Linking.openURL(`paseo://${route.slice(1)}`);
        view.dismiss();
      },
    },
  ];
  if (rootPath && canOpenInNewWindow())
    entries.push({
      key: "window",
      label: "Open in new window",
      icon: "ExternalLink",
      testID: `${testID}-menu-window`,
      onSelect: () => actions.run(() => openInNewWindow(rootPath), "Couldn't open a new window"),
    });
  if (rootPath && folderTarget)
    entries.push({
      key: "folder",
      label: "Open in file manager",
      icon: "FolderOpen",
      testID: `${testID}-menu-folder`,
      onSelect: () =>
        actions.run(() => openInFileManager(folderTarget, rootPath), "Couldn't open the folder"),
    });
  entries.push("separator", {
    key: "assign",
    label: "Move to group",
    icon: "FolderInput",
    testID: `${testID}-menu-assign`,
    onSelect: () => ctx.setEditor({ id, kind: "assign", initial: ctx.pathOf(key) }),
  });
  if (entry.depth > 0)
    entries.push({
      key: "ungroup",
      label: "Remove from group",
      icon: "FolderOutput",
      testID: `${testID}-menu-ungroup`,
      onSelect: () => actions.assign(key, ""),
    });
  // Only a host that runs this plugin can be asked to remove its project.
  if (owner)
    entries.push("separator", {
      key: "remove",
      label: "Remove project",
      icon: "Trash2",
      danger: true,
      keepOpen: true,
      testID: `${testID}-menu-remove`,
      onSelect: () => setConfirmRemove(true),
    });

  return (
    <View>
      <View
        ref={menu.row}
        {...hover}
        style={[
          styles.row,
          { paddingLeft: indent(entry.depth) },
          hovered || menu.placement ? styles.rowHovered : null,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${entry.label}${host ? ` on ${host}` : ""}, ${countLabel}`}
          accessibilityHint={collapsed ? "Shows the workspaces" : "Hides the workspaces"}
          accessibilityState={{ expanded: !collapsed }}
          aria-expanded={!collapsed}
          onPress={() => actions.toggleProject(key)}
          testID={testID}
          style={styles.rowMain}
          {...menu.pressProps}
        >
          {/* As in Paseo's sidebar: the project's icon, the chevron while the row is hovered. */}
          <View style={styles.markSlot}>
            {(hovered || menu.placement) && !ctx.compact ? (
              <Icon
                name={collapsed ? "ChevronRight" : "ChevronDown"}
                size={iconSize}
                color={view.theme.colors.foregroundMuted}
              />
            ) : (
              <ProjectIcon reference={reference} name={project?.displayName ?? entry.label} />
            )}
          </View>
          <Text numberOfLines={1} style={styles.projectLabel} testID={`${testID}-label`}>
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
        {editing ? (
          <MoveButtons
            label={entry.label}
            testID={testID}
            up={moves?.up ?? false}
            down={moves?.down ?? false}
            onMove={(direction) => actions.moveRow(id, direction)}
          />
        ) : ctx.compact || hovered || menu.placement ? (
          // As in Paseo's sidebar, the buttons take room only while they show.
          <>
            <IconButton
              icon="Plus"
              label={`New workspace in ${entry.label}`}
              onPress={openProject}
              testID={`${testID}-new`}
            />
            <MenuTrigger label={`Actions for ${entry.label}`} menu={menu} testID={`${testID}-actions`} />
          </>
        ) : null}
      </View>
      <ActionMenu
        title={`Actions for ${entry.label}`}
        menu={menu}
        entries={entries}
        panel={
          confirmRemove && owner ? (
            <ConfirmPanel
              message={`Remove "${entry.label}" from the sidebar?\n\nFiles on disk will not be changed.`}
              confirmLabel="Remove"
              onCancel={closeMenu}
              onConfirm={() => {
                closeMenu();
                actions.run(() => owner.removeProject(reference.id), "Could not remove the project");
              }}
              testID={`${testID}-actions-menu-confirm`}
            />
          ) : undefined
        }
        onClose={closeMenu}
        testID={`${testID}-actions-menu`}
      />
      {editing && !assigning ? (
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
              // Moving a workspace means a manual order; sorted by time, rows have no moves.
              siblings={
                sort === "manual"
                  ? { projectKey: key, keys: workspaceKeys, key: workspace.key }
                  : undefined
              }
            />
          ))}
      {!collapsed && count === 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New workspace in ${entry.label}`}
          onPress={openProject}
          style={({ pressed }) => [
            styles.row,
            { paddingLeft: indent(entry.depth + 1) },
            pressed ? styles.pressed : null,
          ]}
        >
          <View style={styles.markSlot}>
            <Icon name="Plus" size={iconSize} color={view.theme.colors.foregroundMuted} />
          </View>
          <Text style={styles.projectLabel}>New workspace</Text>
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
  /** The rows it moves among: `workspaceOrder[projectKey]` holds `keys`, this row's is `key`. */
  siblings?: { projectKey: string; keys: readonly string[]; key: string };
}) {
  const ctx = useView();
  const editing = useContext(EditingContext);
  const { styles, view, actions } = ctx;
  const paseo = usePaseo();
  const menu = useRowMenu();
  const [hovered, hover] = useRowHover(menu);
  const [panel, setPanel] = useState<"labels" | "archive" | null>(null);
  const workspace = useWorkspace(reference, (item) => ({
    title: item.title ?? item.name,
    indicator: item.indicator,
    indicatorLabel: item.indicatorLabel,
    status: item.status,
    kind: item.kind,
    directory: item.directory,
    branch: item.branch,
    labels: item.labels,
    pinned: item.pinnedAt !== null,
    archiving: item.archivingAt !== null,
    statusEnteredAt: item.statusEnteredAt,
  }));
  const [confirmArchive, setConfirmArchive] = useState(false);
  const folderTarget = useFolderTarget(menu.placement !== null, workspace?.directory);
  if (!workspace) return null;
  const owner = ctx.host(reference.hostId);
  const worktree = workspace.kind === "worktree";
  const id = `workspace:${reference.key}`;
  const active = view.active.workspace?.key === reference.key;
  const renaming = ctx.editor?.id === id;
  const position = siblings ? siblings.keys.indexOf(siblings.key) : -1;
  const testID = `project-groups-workspace-${reference.key}`;
  const handle = () => paseo.workspaces.ref(reference);
  const status = workspace.indicatorLabel ? `, ${workspace.indicatorLabel}` : "";
  const archive = () => {
    setConfirmArchive(false);
    actions.run(() => handle().archive(), "Could not archive the workspace");
  };
  // A worktree's folder goes with it, and a touch is easy to misplace: both ask first. A local
  // checkout with a pointer archives at once, as in Paseo's own sidebar.
  const asksBeforeArchive = worktree || ctx.compact;
  const closeMenu = () => {
    menu.close();
    setPanel(null);
  };

  const entries: MenuEntry[] = [
    {
      key: "copy-path",
      label: "Copy path",
      icon: "Copy",
      testID: `${testID}-menu-copy-path`,
      onSelect: () => actions.run(() => copyText(workspace.directory), "Could not copy the path"),
    },
  ];
  if (workspace.branch) {
    const branch = workspace.branch;
    entries.push({
      key: "copy-branch",
      label: "Copy branch name",
      icon: "GitBranch",
      testID: `${testID}-menu-copy-branch`,
      onSelect: () => actions.run(() => copyText(branch), "Could not copy the branch name"),
    });
  }
  entries.push({
    key: "rename",
    label: "Rename",
    icon: "Pencil",
    testID: `${testID}-menu-rename`,
    onSelect: () => ctx.setEditor({ id, kind: "rename-workspace", initial: workspace.title }),
  });
  // Paseo's read state: clear the attention of a finished or failed workspace, or bring back an
  // idle one. Only a host that runs this plugin can be asked.
  if (owner && (workspace.status === "attention" || workspace.status === "failed"))
    entries.push({
      key: "read",
      label: "Mark as read",
      icon: "CheckCheck",
      testID: `${testID}-menu-read`,
      onSelect: () => actions.run(() => owner.markRead(reference.id), "Could not mark as read"),
    });
  if (owner && workspace.status === "done")
    entries.push({
      key: "unread",
      label: "Mark as unread",
      icon: "CircleDot",
      testID: `${testID}-menu-unread`,
      onSelect: () => actions.run(() => owner.markUnread(reference.id), "Could not mark as unread"),
    });
  entries.push(
    {
      key: "pin",
      label: workspace.pinned ? "Unpin" : "Pin",
      icon: workspace.pinned ? "PinOff" : "Pin",
      testID: `${testID}-menu-pin`,
      onSelect: () =>
        actions.run(() => handle().setPinned(!workspace.pinned), "Could not change the pin"),
    },
    {
      key: "labels",
      label: "Labels",
      icon: "Tag",
      keepOpen: true,
      testID: `${testID}-menu-labels`,
      onSelect: () => setPanel("labels"),
    },
  );
  if (folderTarget)
    entries.push({
      key: "folder",
      label: "Open in file manager",
      icon: "FolderOpen",
      testID: `${testID}-menu-folder`,
      onSelect: () =>
        actions.run(
          () => openInFileManager(folderTarget, workspace.directory),
          "Couldn't open the folder",
        ),
    });
  entries.push("separator", {
    key: "archive",
    label: "Archive",
    icon: "Archive",
    keepOpen: asksBeforeArchive,
    testID: `${testID}-menu-archive`,
    onSelect: () => {
      if (asksBeforeArchive) setPanel("archive");
      else archive();
    },
  });

  let menuPanel: ReactNode;
  if (panel === "labels")
    menuPanel = (
      <LabelsPanel reference={reference} assigned={workspace.labels} onBack={() => setPanel(null)} />
    );
  else if (panel === "archive")
    menuPanel = (
      <ConfirmPanel
        message={
          worktree
            ? `Archive "${workspace.title}"? Its worktree folder is removed.`
            : `Archive "${workspace.title}"?`
        }
        confirmLabel="Archive"
        onCancel={closeMenu}
        onConfirm={() => {
          closeMenu();
          archive();
        }}
        testID={`${testID}-menu-archive-confirm`}
      />
    );

  return (
    <View>
      <View
        ref={menu.row}
        {...hover}
        style={[
          styles.row,
          { paddingLeft: indent(depth) },
          active ? styles.active : hovered || menu.placement ? styles.rowHovered : null,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${workspace.title}${status}`}
          accessibilityState={{ selected: active }}
          onPress={() => view.navigation.openWorkspace(reference)}
          testID={testID}
          style={styles.rowMain}
          {...menu.pressProps}
        >
          <WorkspaceMark indicator={workspace.indicator} kind={workspace.kind} />
          <Text numberOfLines={1} style={styles.label}>
            {workspace.title}
          </Text>
          {workspace.archiving ? <Text style={styles.detail}>archiving</Text> : null}
        </Pressable>
        {editing && siblings ? (
          <MoveButtons
            label={workspace.title}
            testID={testID}
            up={position > 0}
            down={position >= 0 && position < siblings.keys.length - 1}
            onMove={(direction) =>
              actions.moveWorkspace(siblings.projectKey, siblings.keys, siblings.key, direction)
            }
          />
        ) : null}
        {editing || workspace.archiving ? null : (
          <>
            {/* As in Paseo's sidebar: the last interaction, and in its place on hover the archive
                button and the menu. Touch layouts keep the time and the menu. */}
            {!ctx.compact && (hovered || confirmArchive || menu.placement) ? (
              <IconButton
                icon="Archive"
                label={`Archive ${workspace.title}`}
                onPress={() => {
                  if (asksBeforeArchive) setConfirmArchive(true);
                  else archive();
                }}
                testID={`${testID}-archive`}
              />
            ) : workspace.statusEnteredAt ? (
              <WorkspaceTime at={workspace.statusEnteredAt} />
            ) : null}
            {ctx.compact || hovered || menu.placement ? (
              <MenuTrigger
                label={`Actions for ${workspace.title}`}
                menu={menu}
                testID={`${testID}-actions`}
              />
            ) : null}
          </>
        )}
      </View>
      <ActionMenu
        title={`Actions for ${workspace.title}`}
        menu={menu}
        entries={entries}
        panel={menuPanel}
        onClose={closeMenu}
        testID={`${testID}-actions-menu`}
      />
      {confirmArchive ? (
        <ActionStrip depth={depth + 1}>
          <TextButton
            label={worktree ? "Archive worktree" : "Archive"}
            danger
            accessibilityLabel={`Confirm archiving ${workspace.title}`}
            onPress={archive}
            testID={`${testID}-archive-confirm`}
          />
          <TextButton label="Keep" onPress={() => setConfirmArchive(false)} />
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

/** `workspaceOrder` key of the pinned section; project ref keys are JSON arrays, never this. */
const PINNED_ORDER_KEY = "pinned";

/**
 * A pinned workspace's key in the pinned order: its ref key with the time it was pinned, so a
 * workspace unpinned and pinned again counts as new and goes back on top.
 */
function pinKey(item: { ref: { key: string }; pinnedAt: string | null }): string {
  return `${item.ref.key}@${item.pinnedAt ?? ""}`;
}

/** Pinned workspaces, with their own edit mode for their order. */
function PinnedSection({ editing, onToggleEditing }: { editing: boolean; onToggleEditing(): void }) {
  const { styles, prefs } = useView();
  const order = prefs.workspaceOrder[PINNED_ORDER_KEY];
  const index = useMemo(() => orderIndex(order ?? NONE), [order]);
  const where = (workspace: { pinnedAt: string | null; background: boolean }) =>
    workspace.pinnedAt !== null && !workspace.background;
  // Ordered as moved in edit mode, with workspaces pinned since on top, newest first.
  const pinned = useWorkspaces({
    where,
    orderBy: (a, b) =>
      compareOrdered(
        index,
        pinKey(a),
        pinKey(b),
        (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") || a.ref.key.localeCompare(b.ref.key),
        "first",
      ),
  });
  // The SDK hands back refs only; grouping by pin key reads each one's.
  const stamped = useWorkspaces({ where, groupBy: pinKey });
  const keys = useMemo(() => {
    const byRef = new Map(stamped.flatMap((group) => group.items.map((ref) => [ref.key, group.key])));
    return pinned.map((reference) => byRef.get(reference.key) ?? reference.key);
  }, [pinned, stamped]);
  if (pinned.length === 0) return null;
  return (
    <View style={styles.pinnedSection} testID="project-groups-pinned">
      <SectionHeader title="Pinned" testID="project-groups-pinned-header">
        <HeaderButton
          icon={editing ? "Check" : "Pencil"}
          label={editing ? "Done editing pinned workspaces" : "Edit pinned workspaces"}
          active={editing}
          onPress={onToggleEditing}
          testID="project-groups-pinned-header-edit"
        />
      </SectionHeader>
      <EditingContext.Provider value={editing}>
        {pinned.map((reference, position) => (
          <WorkspaceRow
            key={reference.key}
            reference={reference}
            depth={0}
            siblings={{ projectKey: PINNED_ORDER_KEY, keys, key: keys[position] ?? reference.key }}
          />
        ))}
      </EditingContext.Provider>
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
  // Each section has its own edit mode: the pinned order, and the projects' groups and order.
  const [editing, setEditing] = useState(false);
  const [editingPinned, setEditingPinned] = useState(false);
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

  const close = () => setEditor(null);

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
    setWorkspaceSort(sort) {
      savePrefs((values) => ({ ...values, workspaceSort: sort }));
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
    // Paseo's `md` icon: 16pt with a pointer, 20pt on touch layouts.
    iconSize: surface.compact ? 20 : 16,
    compact: surface.compact,
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
    host: (hostId) => ready.find((entry) => entry.hostId === hostId),
    actions,
  };

  const problems = hosts.flatMap((host) =>
    host.status.status === "invalid" || host.status.status === "error"
      ? [{ host, message: host.status.error }]
      : [],
  );

  return (
    <ViewContext.Provider value={context}>
      {/* Three children, so the projects header is always child 1 and sticks to the top. */}
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[1]}
        testID="project-groups-view"
      >
        <View>
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
          <PinnedSection
            editing={editingPinned}
            onToggleEditing={() => setEditingPinned((current) => !current)}
          />
        </View>
        <SectionHeader title="Projects" sticky testID="project-groups-projects-header">
          <ProjectsHeaderActions
            editing={editing}
            onToggleEditing={() => {
              close();
              setEditing((current) => !current);
            }}
          />
        </SectionHeader>
        <EditingContext.Provider value={editing}>
          {layout.map((entry) => {
            if (entry.hidden) return null;
            if (entry.kind === "group") return <GroupRow key={entryId(entry)} entry={entry} />;
            const reference = refs.get(entry.key);
            return reference ? (
              <ProjectBlock key={entryId(entry)} entry={entry} reference={reference} />
            ) : null;
          })}
          {projectRows.length === 0 ? <Text style={styles.notice}>No projects yet</Text> : null}
        </EditingContext.Provider>
      </ScrollView>
    </ViewContext.Provider>
  );
}
