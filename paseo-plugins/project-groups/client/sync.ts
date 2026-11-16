// Keeps one host's group document in that daemon's host-scoped plugin settings. Changes show at
// once and are then written with the last known revision; on a conflict the change is re-applied
// to the fresh values and retried. An invalid stored document is never overwritten by a change.

export type SettingsRead =
  | { status: "ready"; revision: string; values: unknown }
  | { status: "invalid"; revision: string; error: string };

export type SettingsWrite =
  | { status: "saved"; revision: string; values: unknown }
  | { status: "conflict"; error: string }
  | { status: "invalid"; error: string };

export type DocumentStatus =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "invalid"; error: string }
  | { status: "error"; error: string };

export interface DocumentSyncOptions<Doc> {
  read(): Promise<SettingsRead>;
  write(revision: string, values: Doc): Promise<SettingsWrite>;
  /** Throws when the values do not fit the schema. */
  parse(values: unknown): Doc;
  empty: Doc;
  onChange(doc: Doc, status: DocumentStatus): void;
  onError(error: unknown): void;
}

export type DocumentChange<Doc> = (doc: Doc) => Doc;

export interface DocumentSync<Doc> {
  /** Re-read from the daemon. Skipped while a write is in flight. */
  refresh(): Promise<void>;
  /** Resolves once saved; rejects when the change could not be saved. */
  update(change: DocumentChange<Doc>): Promise<void>;
  current(): Doc;
  status(): DocumentStatus;
}

const MAX_ATTEMPTS = 3;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDocumentSync<Doc>(
  options: DocumentSyncOptions<Doc>,
): DocumentSync<Doc> {
  let revision: string | null = null;
  let stored: Doc = options.empty;
  let shown: Doc = options.empty;
  let state: DocumentStatus = { status: "loading" };
  let pending = 0;
  let queue: Promise<void> = Promise.resolve();

  function show(next: Doc) {
    shown = next;
    options.onChange(shown, state);
  }

  async function load() {
    const result = await options.read();
    revision = result.revision;
    if (result.status === "invalid") {
      stored = options.empty;
      state = { status: "invalid", error: result.error };
      return;
    }
    try {
      stored = options.parse(result.values);
      state = { status: "ready" };
    } catch (error) {
      stored = options.empty;
      state = { status: "invalid", error: message(error) };
    }
  }

  async function persist(change: DocumentChange<Doc>) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (revision === null || state.status === "error") await load();
      if (state.status !== "ready")
        throw new Error(
          state.status === "invalid" || state.status === "error"
            ? `Group settings can't be saved: ${state.error}`
            : "Group settings are still loading",
        );
      const result = await options.write(revision ?? "", change(stored));
      if (result.status === "saved") {
        revision = result.revision;
        stored = options.parse(result.values);
        return;
      }
      if (result.status === "invalid") throw new Error(result.error);
      revision = null;
    }
    throw new Error("Group settings kept changing while saving");
  }

  return {
    refresh() {
      if (pending > 0) return Promise.resolve();
      // Reads queue behind writes, so an older read can never replace a newer save.
      const done = queue.then(async () => {
        try {
          await load();
        } catch (error) {
          state = { status: "error", error: message(error) };
          options.onError(error);
        }
        if (pending === 0) show(stored);
      });
      queue = done;
      return done;
    },
    update(change) {
      pending += 1;
      show(change(shown));
      const saved = queue.then(() => persist(change));
      const settled = saved.finally(() => {
        pending -= 1;
        if (pending === 0) show(stored);
      });
      queue = settled.catch((error: unknown) => {
        options.onError(error);
      });
      return settled;
    },
    current: () => shown,
    status: () => state,
  };
}
