// Minimal ambient types for the parts of the OMP extension API this extension
// uses. OMP provides these modules at runtime; they are not installed here.
// Source (omp 18.20.0): packages/coding-agent/src/extensibility/extensions/types.ts,
// packages/coding-agent/src/config/registry.ts, packages/tui/src/overlays/ask-dialog.ts,
// packages/tui/src/terminal-capabilities.ts in can1357/oh-my-pi.

declare module "@oh-my-pi/pi-coding-agent/config/registry" {
  export interface Setting<T> {
    get(scope: unknown): T;
  }
  export function lookup(id: string): Setting<unknown> | undefined;
}

declare module "@oh-my-pi/pi-tui" {
  export const TERMINAL: {
    sendNotification(message: {
      title: string;
      body: string;
      type: string;
      urgency: "low" | "normal" | "critical";
      actions: string;
    }): void;
  };
}

declare module "@oh-my-pi/pi-tui/theme" {
  export const theme: { status: { success: string } };
}

declare module "@oh-my-pi/pi-coding-agent" {
  export interface AgentToolResult<TDetails> {
    content: { type: "text"; text: string }[];
    details?: TDetails;
  }

  export interface ExtensionUIContext {
    timeoutStartsOnPresentation?: boolean;
    select(
      title: string,
      options: (string | { label: string; description?: string })[],
      dialogOptions?: { signal?: AbortSignal; timeout?: number; initialIndex?: number },
    ): Promise<string | undefined>;
    editor(
      title: string,
      prefill?: string,
      dialogOptions?: { signal?: AbortSignal },
      editorOptions?: { promptStyle?: boolean },
    ): Promise<string | undefined>;
    /** Present on hosts with the rich ask dialog: the interactive TUI, RPC hosts after `set_ask_dialog`. */
    askDialog?(
      questions: {
        id: string;
        question: string;
        header?: string;
        options: { label: string; description?: string; preview?: string }[];
        multi?: boolean;
        recommended?: number;
      }[],
      dialogOptions?: { signal?: AbortSignal; timeout?: number },
    ): Promise<
      | {
          kind: "submit";
          results: {
            id: string;
            selectedOptions: string[];
            customInput?: string;
            note?: string;
            noteOption?: string;
            timedOut?: boolean;
          }[];
        }
      | { kind: "chat" }
      | undefined
    >;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    mode: "tui" | "rpc" | "json" | "print";
    /** False in print mode, headless RPC, and subagents. */
    hasUI: boolean;
    abort(): void;
    hasPendingMessages(): boolean;
    /** Interactive TUI sessions only. */
    sessionModes?: { getState(): { plan: { status: "inactive" | "active" | "paused" } } };
  }

  /** Opaque omptype schema built with `pi.zod`. */
  export interface Schema<T> {
    readonly __infer?: T;
    describe(description: string): Schema<T>;
    optional(): Schema<T | undefined>;
    min(bound: number): Schema<T>;
  }

  export interface ToolDefinition<T, TDetails> {
    name: string;
    label: string;
    description: string;
    parameters: Schema<T>;
    loadMode?: "essential" | "discoverable";
    approval?: "read" | "write" | "exec";
    strict?: boolean;
    execute(
      toolCallId: string,
      params: T,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TDetails>>;
  }

  type Optional<T> = { [K in keyof T as undefined extends T[K] ? K : never]?: T[K] } & {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K];
  };

  export interface Zod {
    object<T extends Record<string, Schema<unknown>>>(
      shape: T,
    ): Schema<Optional<{ [K in keyof T]: T[K] extends Schema<infer V> ? V : never }>>;
    array<T>(element: Schema<T>): Schema<T[]>;
    string(): Schema<string>;
    number(): Schema<number>;
    boolean(): Schema<boolean>;
  }

  export interface ExtensionAPI {
    zod: Zod;
    /** Package exports; `settings` is the process-wide Settings instance. */
    pi: { settings: unknown };
    registerTool<T, TDetails>(tool: ToolDefinition<T, TDetails>): void;
    on(
      event: "session_start",
      handler: (event: { type: "session_start" }, ctx: ExtensionContext) => Promise<void> | void,
    ): void;
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): Promise<void>;
  }
}
