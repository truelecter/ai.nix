// Web and desktop-only access: the collapsed groups Paseo 0.15's DOM version of this plugin kept
// in browser storage (read once), in-app navigation to routes the plugin SDK has no call for, the
// desktop app's window and file-manager bridge (`window.paseoDesktop`, the one Paseo's own
// project menu uses), and the pointer's position for row hover. Everything here is a no-op off
// the web.

import { Platform } from "react-native";

const LEGACY_COLLAPSED_KEY = "paseo-plugin:project-groups:collapsed";

/** Group paths collapsed in this browser before Paseo 0.16; empty off the web or when none. */
export function readLegacyCollapsed(): string[] {
  if (Platform.OS !== "web") return [];
  const storage: unknown = Reflect.get(globalThis, "localStorage");
  if (!storage || typeof storage !== "object" || !("getItem" in storage)) return [];
  if (typeof storage.getItem !== "function") return [];
  try {
    const raw: unknown = storage.getItem(LEGACY_COLLAPSED_KEY);
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : [];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

interface WebHistory {
  pushState(state: unknown, unused: string, url: string): void;
}

interface WebWindow {
  history: WebHistory;
  dispatchEvent(event: unknown): boolean;
}

type PopStateEventConstructor = new (type: string, init?: { state?: unknown }) => unknown;

/**
 * Opens an app route (`/settings/...`) in this window. Paseo's web router follows `popstate`, so
 * the route is pushed and announced the way a browser back or forward would be. False off the web.
 */
export function navigateInApp(route: string): boolean {
  if (Platform.OS !== "web") return false;
  const win = Reflect.get(globalThis, "window") as WebWindow | undefined;
  const PopState = Reflect.get(globalThis, "PopStateEvent") as PopStateEventConstructor | undefined;
  if (!win?.history || !PopState) return false;
  win.history.pushState(null, "", route);
  win.dispatchEvent(new PopState("popstate", { state: null }));
  return true;
}

interface DesktopOpenTarget {
  id: string;
  kind: string;
}

interface DesktopHost {
  window?: { openNew?(input: { pendingOpenProjectPath: string }): Promise<unknown> };
  editor?: {
    listTargets?(input: { workspacePath?: string }): Promise<DesktopOpenTarget[]>;
    openTarget?(input: { editorId: string; workspacePath: string }): Promise<unknown>;
  };
}

function desktopHost(): DesktopHost | null {
  if (Platform.OS !== "web") return null;
  const host: unknown = Reflect.get(globalThis, "paseoDesktop");
  return host && typeof host === "object" ? (host as DesktopHost) : null;
}

/** The desktop app can open a project in a new window. */
export function canOpenInNewWindow(): boolean {
  return typeof desktopHost()?.window?.openNew === "function";
}

export async function openInNewWindow(path: string): Promise<void> {
  const openNew = desktopHost()?.window?.openNew;
  if (!openNew) throw new Error("This app can't open new windows");
  await openNew({ pendingOpenProjectPath: path });
}

/** The desktop app's file-manager target for `path`, or null when it has none. */
export async function fileManagerTarget(path: string): Promise<string | null> {
  const editor = desktopHost()?.editor;
  if (!editor?.listTargets || !editor.openTarget) return null;
  const targets = await editor.listTargets({ workspacePath: path });
  return targets.find((target) => target.kind === "file-manager")?.id ?? null;
}

export async function openInFileManager(targetId: string, path: string): Promise<void> {
  const openTarget = desktopHost()?.editor?.openTarget;
  if (!openTarget) throw new Error("This app can't open folders");
  await openTarget({ editorId: targetId, workspacePath: path });
}

interface PointerDocument {
  addEventListener(
    type: "pointermove",
    listener: (event: { clientX: number; clientY: number }) => void,
    options: { capture: boolean; passive: boolean },
  ): void;
}

interface Measurable {
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number };
}

let lastPointer: { x: number; y: number } | null = null;
let trackingPointer = false;

/** Starts following the pointer's window position, once per page. */
export function trackPointer(): void {
  if (trackingPointer || Platform.OS !== "web") return;
  const doc = Reflect.get(globalThis, "document") as PointerDocument | undefined;
  if (!doc) return;
  trackingPointer = true;
  doc.addEventListener(
    "pointermove",
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
}

/** Whether the pointer's last position is inside `node`, a react-native-web `View`'s element. */
export function pointerInside(node: unknown): boolean {
  const pointer = lastPointer;
  if (!pointer || !node || typeof node !== "object" || !("getBoundingClientRect" in node)) {
    return false;
  }
  if (typeof node.getBoundingClientRect !== "function") return false;
  // A DOM element: react-native-web renders a View as one.
  const rect = (node as Measurable).getBoundingClientRect();
  return (
    pointer.x >= rect.left && pointer.x < rect.right && pointer.y >= rect.top && pointer.y < rect.bottom
  );
}
