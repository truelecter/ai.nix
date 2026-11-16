// The only DOM access: reading the collapsed groups Paseo 0.15's DOM version of this plugin kept
// in browser storage, once, so they carry over to the device layout settings.

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
