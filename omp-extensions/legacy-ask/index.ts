import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
  ASK_DESCRIPTION,
  askFieldByField,
  type AskOutcome,
  type AskQuestion,
  type AskToolDetails,
  richDialogOutcome,
  richDialogQuestions,
  sanitizeQuestions,
  untilAborted,
  validateQuestions,
} from "./shared/ask.ts";

export default function legacyAsk(pi: ExtensionAPI): void {
  const z = pi.zod;
  const option = z.object({
    label: z.string(),
    description: z.string().optional(),
    preview: z.string().describe("rich preview").optional(),
  });
  const question = z.object({
    id: z.string(),
    question: z.string(),
    header: z.string().describe("display chip").optional(),
    options: z.array(option),
    multi: z.boolean().optional(),
    recommended: z.number().describe("0-based default index").optional(),
  });

  pi.registerTool<{ questions: AskQuestion[] }, AskToolDetails>({
    name: "ask",
    label: "Ask",
    description: ASK_DESCRIPTION,
    parameters: z.object({ questions: z.array(question).min(1) }),
    // Same presentation and approval tier as the built-in `ask` it replaces.
    loadMode: "discoverable",
    approval: "read",
    strict: true,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        ctx.abort();
        throw new Error("Ask tool requires interactive mode");
      }
      const doneLabel = `${theme.status.success} Done selecting`;
      // Models occasionally inject `\r` runs into string values; sanitize before
      // the dialog renders or the answer echoes back into session history.
      const questions = sanitizeQuestions(params.questions);
      const invalid = validateQuestions(questions, doneLabel);
      if (invalid !== undefined) return { content: [{ type: "text", text: invalid }], details: {} };

      // `ask.timeout` in seconds, 0 for none; plan mode never times out.
      const seconds = Number(lookup("ask.timeout")?.get(pi.pi.settings) ?? 0);
      const planMode = ctx.sessionModes?.getState().plan.status === "active";
      const timeout = planMode || !(seconds > 0) ? undefined : seconds * 1000;

      // Only the terminal: in RPC modes stdout carries the protocol.
      if (ctx.mode === "tui" && lookup("ask.notify")?.get(pi.pi.settings) !== "off") {
        TERMINAL.sendNotification({
          title: "omp",
          body: "Waiting for input",
          type: "ask",
          urgency: "normal",
          actions: "focus",
        });
      }

      // A chat message sent while the form is open closes it (Paseo steers, then
      // cancels the prompt): end the call without aborting the run, so the
      // message reaches the agent at the next step.
      const interrupted = () =>
        new Error(ctx.hasPendingMessages() ? "Ask interrupted by message" : "Ask input was cancelled");
      let outcome: AskOutcome;
      try {
        const { askDialog } = ctx.ui;
        outcome = askDialog
          ? richDialogOutcome(
              questions,
              await untilAborted(signal ?? new AbortController().signal, () =>
                askDialog.call(ctx.ui, richDialogQuestions(questions), { timeout, signal }),
              ),
            )
          : await askFieldByField(ctx.ui, questions, { doneLabel, timeout, signal });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw interrupted();
        throw error;
      }
      if (outcome.kind === "cancelled") {
        if (ctx.hasPendingMessages()) throw interrupted();
        ctx.abort();
        throw new Error("Ask tool was cancelled by the user");
      }
      return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
    },
  });

  // The built-in `ask` exists only where someone can answer; without a UI
  // (print mode, headless RPC, subagents) this one goes too.
  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    if (!ctx.hasUI && active.includes("ask")) await pi.setActiveTools(active.filter((name) => name !== "ask"));
  });
}
