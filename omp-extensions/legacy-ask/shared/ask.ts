// The question-based `ask` tool of OMP up to v18.18.2
// (packages/coding-agent/src/tools/ask.ts in can1357/oh-my-pi), ported without
// OMP internals: the UI, settings, and theme come in through parameters.

export const OTHER_OPTION = "Other (type your own)";
const CHAT_ABOUT_THIS_OPTION = "Chat about this";
const NEXT_OPTION = "Next →";
const RESERVED_OPTION_LABELS = new Set([OTHER_OPTION, CHAT_ABOUT_THIS_OPTION, NEXT_OPTION]);
const RECOMMENDED_SUFFIX = " (Recommended)";
// Window after the timeout deadline within which an `undefined` selection is
// attributed to a UI-enforced timeout (for surfaces that close the dialog at
// the deadline but never invoke `onTimeout`). Cancels beyond it are user Esc.
const TIMEOUT_DETECTION_TOLERANCE_MS = 1_000;
const ERROR_VALUE_MAX_LENGTH = 120;

export const ASK_DESCRIPTION = `Ask only for materially different tradeoffs the user must decide. Default: act using code/config/docs/history and conventions. Several viable choices: pick conservative/standard, proceed, state choice.

<instruction>
- Batch related questions; 2-5 distinct options each; short labels, tradeoffs in \`description\`.
- \`recommended\` auto-adds " (Recommended)"; \`multi: true\` permits multiple selections.
- NEVER supply "Other": UI adds "Other (type your own)". Clarifying custom input? Answer first; re-ask unresolved questions.
- Blocks immediately: MUST first emit unseen decision context (findings, diffs, drafts) as assistant text, even when batching \`ask\` with other tools.
</instruction>`;

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi?: boolean;
  recommended?: number;
}

export interface SelectOption {
  label: string;
  description?: string;
}

export type SelectItem = string | SelectOption;

export interface SelectDialogOptions {
  initialIndex?: number;
  timeout?: number;
  signal?: AbortSignal;
  outline?: boolean;
  onTimeout?: () => void;
  onTimeoutStart?: () => void;
  onTimeoutReset?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: readonly number[];
  markableCount?: number;
}

/** The parts of OMP's extension UI the field-by-field dialogs use. */
export interface FallbackUI {
  timeoutStartsOnPresentation?: boolean;
  select(title: string, options: SelectItem[], dialogOptions?: SelectDialogOptions): Promise<string | undefined>;
  editor(
    title: string,
    prefill?: string,
    dialogOptions?: { signal?: AbortSignal },
    editorOptions?: { promptStyle?: boolean },
  ): Promise<string | undefined>;
}

export interface QuestionResult {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  noteOption?: string;
  timedOut?: boolean;
}

/** Tool result details, the shape OMP's `ask` returned up to v18.18.2. */
export interface AskToolDetails {
  question?: string;
  options?: string[];
  multi?: boolean;
  selectedOptions?: string[];
  customInput?: string;
  note?: string;
  noteOption?: string;
  timedOut?: boolean;
  results?: QuestionResult[];
  chatRedirect?: boolean;
  questions?: string[];
}

/** A finished ask: the text for the model and the details, or a cancel. */
export type AskOutcome = { kind: "answered"; text: string; details: AskToolDetails } | { kind: "cancelled" };

interface SelectionResult {
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut: boolean;
  navigation?: "back" | "forward";
  cancelled?: boolean;
}

interface NavigationControls {
  allowBack: boolean;
  allowForward: boolean;
  progressText?: string;
}

interface AskSingleQuestionOptions {
  doneLabel: string;
  recommended?: number;
  timeout?: number;
  signal?: AbortSignal;
  initialSelection?: Pick<SelectionResult, "selectedOptions" | "customInput" | "note">;
  navigation?: NavigationControls;
}

export function sanitizeCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replaceAll("\r\n", "\n").replace(/\r+/g, " ");
}

/**
 * Unique display copies of option labels: labels that sanitize alike or match
 * a reserved row take a numeric suffix. Order and length are preserved.
 */
export function disambiguateDisplayLabels(rawLabels: string[], reservedLabels: readonly string[]): string[] {
  const taken = new Set<string>(reservedLabels);
  return rawLabels.map((raw) => {
    const base = sanitizeCarriageReturns(raw);
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base} (${suffix})`;
    taken.add(candidate);
    return candidate;
  });
}

/** Rejects with an `AbortError` once `signal` aborts. */
export function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const abortError = () => Object.assign(new Error("Aborted"), { name: "AbortError" });
  if (signal.aborted) return Promise.reject(abortError());
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  run()
    .then(resolve, reject)
    .finally(() => signal.removeEventListener("abort", onAbort));
  return promise;
}

function toSelectOption(option: SelectOption, label = option.label): SelectItem {
  return option.description ? { label, description: option.description } : label;
}

function selectItemLabel(option: SelectItem): string {
  return typeof option === "string" ? option : option.label;
}

function addRecommendedSuffix(options: SelectOption[], recommendedIndex?: number): SelectItem[] {
  if (recommendedIndex === undefined || recommendedIndex < 0 || recommendedIndex >= options.length) {
    return options.map((option) => toSelectOption(option));
  }
  return options.map((option, i) => {
    const label =
      i === recommendedIndex && !option.label.endsWith(RECOMMENDED_SUFFIX)
        ? option.label + RECOMMENDED_SUFFIX
        : option.label;
    return toSelectOption(option, label);
  });
}

function autoSelectionOnTimeout(options: SelectOption[], recommended?: number): string[] {
  if (options.length === 0) return [];
  if (typeof recommended === "number" && recommended >= 0 && recommended < options.length) {
    return [options[recommended]!.label];
  }
  return [options[0]!.label];
}

function formatErrorValue(value: string): string {
  const text = value.replaceAll("\t", "   ");
  return text.length > ERROR_VALUE_MAX_LENGTH ? `${text.slice(0, ERROR_VALUE_MAX_LENGTH - 3)}...` : text;
}

/** Strips the `\r` runs degenerate models inject, so persisted call args render as prose. */
export function sanitizeQuestions(questions: AskQuestion[]): AskQuestion[] {
  return questions.map((question) => ({
    ...question,
    id: sanitizeCarriageReturns(question.id),
    question: sanitizeCarriageReturns(question.question),
    ...(question.header !== undefined ? { header: sanitizeCarriageReturns(question.header) } : {}),
    options: question.options.map((option) => ({
      ...option,
      label: sanitizeCarriageReturns(option.label),
      ...(option.description !== undefined ? { description: sanitizeCarriageReturns(option.description) } : {}),
      ...(option.preview !== undefined ? { preview: sanitizeCarriageReturns(option.preview) } : {}),
    })),
  }));
}

/**
 * The error text for questions the dialogs can't show, or `undefined`: an
 * empty list, labels that collide with the reserved rows (`doneLabel` for
 * multi-select), duplicate ids, or duplicate labels within a question.
 */
export function validateQuestions(questions: AskQuestion[], doneLabel: string): string | undefined {
  if (questions.length === 0) return "Error: questions must not be empty";
  const reserved = questions
    .flatMap((question) => question.options)
    .find((option) => RESERVED_OPTION_LABELS.has(option.label));
  if (reserved !== undefined) {
    return `Error: option labels must not collide with reserved runtime labels: ${formatErrorValue(reserved.label)}`;
  }
  const done = questions
    .filter((question) => question.multi === true)
    .flatMap((question) => question.options)
    .find((option) => option.label === doneLabel);
  if (done !== undefined) {
    return `Error: option labels must not collide with reserved runtime labels: ${formatErrorValue(done.label)}`;
  }
  const seenIds = new Set<string>();
  for (const question of questions) {
    if (seenIds.has(question.id)) return `Error: question ids must be unique: ${formatErrorValue(question.id)}`;
    seenIds.add(question.id);
    const seenLabels = new Set<string>();
    for (const option of question.options) {
      if (seenLabels.has(option.label)) {
        return `Error: option labels must be unique within a question: ${formatErrorValue(option.label)}`;
      }
      seenLabels.add(option.label);
    }
  }
  return undefined;
}

async function askSingleQuestion(
  ui: FallbackUI,
  question: string,
  questionOptions: SelectOption[],
  multi: boolean,
  options: AskSingleQuestionOptions,
): Promise<SelectionResult> {
  const { doneLabel, recommended, timeout, signal, initialSelection, navigation } = options;
  let selectedOptions = [...(initialSelection?.selectedOptions ?? [])];
  let customInput = initialSelection?.customInput;
  const note = initialSelection?.note;
  let timedOut = false;

  const selectOption = async (
    prompt: string,
    optionsToShow: SelectItem[],
    initialIndex: number | undefined,
    marker: { selectionMarker: "radio" | "checkbox"; checkedIndices?: readonly number[]; markableCount: number },
  ): Promise<{ choice: string | undefined; timedOut: boolean; navigation?: "back" | "forward" }> => {
    let timeoutTriggered = false;
    let navigationAction: "back" | "forward" | undefined;
    const timeoutMs = typeof timeout === "number" && timeout > 0 ? timeout : undefined;
    const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
    const dialogSignal =
      signal && timeoutController
        ? AbortSignal.any([signal, timeoutController.signal])
        : (timeoutController?.signal ?? signal);
    let timeoutId: NodeJS.Timeout | undefined;
    let timeoutStartedMs = Date.now();
    const armFallbackTimeout = (durationMs: number) => {
      clearTimeout(timeoutId);
      timeoutStartedMs = Date.now();
      timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        timeoutController?.abort();
      }, durationMs);
    };
    const dialogOptions: SelectDialogOptions = {
      initialIndex,
      timeout,
      signal: dialogSignal,
      outline: true,
      onTimeout: () => {
        timeoutTriggered = true;
      },
      onTimeoutStart: timeoutMs === undefined ? undefined : () => armFallbackTimeout(timeoutMs),
      onTimeoutReset: timeoutMs === undefined ? undefined : () => armFallbackTimeout(timeoutMs),
      selectionMarker: marker.selectionMarker,
      checkedIndices: marker.checkedIndices,
      markableCount: marker.markableCount,
      onLeft: navigation?.allowBack
        ? () => {
            navigationAction = "back";
          }
        : undefined,
      onRight: navigation?.allowForward
        ? () => {
            navigationAction = "forward";
          }
        : undefined,
    };
    try {
      const runSelect = () => {
        const selection = ui.select(prompt, optionsToShow, dialogOptions);
        if (timeoutMs !== undefined && !ui.timeoutStartsOnPresentation) armFallbackTimeout(timeoutMs);
        return selection;
      };
      const choice = dialogSignal ? await untilAborted(dialogSignal, runSelect) : await runSelect();
      if (!timeoutTriggered && choice === undefined && typeof timeout === "number") {
        // Fallback for UI surfaces that enforce `timeout` without invoking
        // `onTimeout`: their auto-cancel resolves right at the deadline. A
        // cancel arriving well past the deadline is a deliberate user Esc.
        const elapsed = Date.now() - timeoutStartedMs;
        timeoutTriggered = elapsed >= timeout && elapsed <= timeout + TIMEOUT_DETECTION_TOLERANCE_MS;
      }
      return { choice, timedOut: timeoutTriggered, navigation: navigationAction };
    } catch (error) {
      if (timeoutTriggered && error instanceof Error && error.name === "AbortError") {
        return { choice: undefined, timedOut: true, navigation: navigationAction };
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const promptForCustomInput = async (title: string): Promise<string | undefined> => {
    const show = () => ui.editor(title, undefined, signal ? { signal } : undefined, { promptStyle: true });
    return signal ? await untilAborted(signal, show) : await show();
  };

  const promptWithProgress = navigation?.progressText ? `${question} (${navigation.progressText})` : question;
  if (multi) {
    const selected = new Set<string>(selectedOptions);
    let cursorIndex = Math.min(Math.max(recommended ?? 0, 0), Math.max(questionOptions.length - 1, 0));
    const firstSelected = selectedOptions[0];
    if (firstSelected) {
      const selectedIndex = questionOptions.findIndex((option) => option.label === firstSelected);
      if (selectedIndex >= 0) cursorIndex = selectedIndex;
    }
    while (true) {
      const opts: SelectItem[] = questionOptions.map((opt) => toSelectOption(opt));
      // Arrow-key forward navigation is TUI-only; RPC clients need the Done row to advance.
      if (selected.size > 0) opts.push(doneLabel);
      opts.push(OTHER_OPTION);

      const checkedIndices: number[] = [];
      for (let i = 0; i < questionOptions.length; i++) {
        if (selected.has(questionOptions[i]!.label)) checkedIndices.push(i);
      }
      const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
      const {
        choice,
        timedOut: selectTimedOut,
        navigation: arrowNavigation,
      } = await selectOption(`${prefix}${promptWithProgress}`, opts, cursorIndex, {
        selectionMarker: "checkbox",
        checkedIndices,
        markableCount: questionOptions.length,
      });

      if (arrowNavigation) {
        return { selectedOptions: Array.from(selected), customInput, note, timedOut, navigation: arrowNavigation };
      }
      if (choice === undefined) {
        if (selectTimedOut) {
          timedOut = true;
          break;
        }
        return { selectedOptions: Array.from(selected), customInput, note, timedOut, cancelled: true };
      }
      if (choice === doneLabel) break;

      if (choice === OTHER_OPTION) {
        if (selectTimedOut) {
          timedOut = true;
          break;
        }
        const input = await promptForCustomInput(`${prefix}${promptWithProgress}`);
        if (input === undefined) continue;
        customInput = input;
        break;
      }

      const selectedIdx = opts.findIndex((opt) => selectItemLabel(opt) === choice);
      if (selectedIdx >= 0) cursorIndex = selectedIdx;
      if (selected.has(choice)) selected.delete(choice);
      else selected.add(choice);

      if (selectTimedOut) {
        timedOut = true;
        break;
      }
    }
    selectedOptions = Array.from(selected);
  } else {
    while (true) {
      const baseDisplay = addRecommendedSuffix(questionOptions, recommended);
      // Badging can collide rows (recommended `Retry now` vs a literal
      // `Retry now (Recommended)`); disambiguate display copies and map the
      // choice back by index below.
      const displayLabels = disambiguateDisplayLabels(baseDisplay.map(selectItemLabel), [OTHER_OPTION]);
      const displayOptions: SelectItem[] = baseDisplay.map((option, index) =>
        typeof option === "string" ? displayLabels[index]! : { ...option, label: displayLabels[index]! },
      );
      const optionsWithOther: SelectItem[] = [...displayOptions, OTHER_OPTION];

      let initialIndex = recommended;
      const previouslySelected = selectedOptions[0];
      if (previouslySelected) {
        const selectedIndex = questionOptions.findIndex((option) => option.label === previouslySelected);
        if (selectedIndex >= 0) initialIndex = selectedIndex;
      } else if (customInput !== undefined) {
        initialIndex = displayOptions.length;
      }
      if (initialIndex !== undefined) {
        initialIndex = Math.max(0, Math.min(initialIndex, Math.max(optionsWithOther.length - 1, 0)));
      }

      const {
        choice,
        timedOut: selectTimedOut,
        navigation: arrowNavigation,
      } = await selectOption(promptWithProgress, optionsWithOther, initialIndex, {
        selectionMarker: "radio",
        markableCount: displayOptions.length,
      });
      timedOut = selectTimedOut;

      if (arrowNavigation) return { selectedOptions, customInput, note, timedOut, navigation: arrowNavigation };
      if (choice === undefined) {
        if (!timedOut) return { selectedOptions, customInput, note, timedOut, cancelled: true };
        break;
      }
      if (choice === OTHER_OPTION) {
        if (selectTimedOut) break;
        const input = await promptForCustomInput(promptWithProgress);
        if (input === undefined) continue;
        customInput = input;
        selectedOptions = [];
        break;
      }
      // Map the displayed choice back to the offered option by position: the
      // label itself may end with the recommendation suffix, so stripping
      // would corrupt it. First display match wins on identical rows.
      const pickedIndex = displayOptions.findIndex((option) => selectItemLabel(option) === choice);
      const fallbackLabel = choice.endsWith(RECOMMENDED_SUFFIX) ? choice.slice(0, -RECOMMENDED_SUFFIX.length) : choice;
      selectedOptions = [pickedIndex >= 0 ? questionOptions[pickedIndex]!.label : fallbackLabel];
      customInput = undefined;
      break;
    }
    if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
      selectedOptions = autoSelectionOnTimeout(questionOptions, recommended);
    }
    if (navigation?.allowForward) return { selectedOptions, customInput, note, timedOut, navigation: "forward" };
  }

  if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
    selectedOptions = autoSelectionOnTimeout(questionOptions, recommended);
  }
  return { selectedOptions, customInput, note, timedOut };
}

export function formatQuestionResult(result: QuestionResult): string {
  const noteOn = result.noteOption === undefined ? "" : ` on ${result.noteOption}`;
  const noteSuffix = result.note ? ` (note${noteOn}: ${result.note})` : "";
  const custom = result.customInput === undefined ? undefined : `"${result.customInput}"`;
  if (result.selectedOptions.length === 0) {
    if (custom !== undefined) return `${result.id}: ${custom}${noteSuffix}`;
    return result.multi ? `${result.id}: []${noteSuffix}` : `${result.id}: (cancelled)${noteSuffix}`;
  }
  const picked = result.multi ? `[${result.selectedOptions.join(", ")}]` : result.selectedOptions[0];
  const answer = custom === undefined ? picked : `${picked} + ${custom}`;
  const timeoutSuffix = result.timedOut ? " (auto-selected after timeout)" : "";
  return `${result.id}: ${answer}${timeoutSuffix}${noteSuffix}`;
}

function indented(label: string, text: string): string {
  return text.includes("\n")
    ? `${label}\n${text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`
    : `${label} ${text}`;
}

export function formatSingleQuestionResponse(result: {
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  noteOption?: string;
  timedOut?: boolean;
  multi: boolean;
}): string {
  const parts: string[] = [];
  if (result.selectedOptions.length > 0) {
    const selectedText = result.multi
      ? `User selected: ${result.selectedOptions.join(", ")}`
      : `User selected: ${result.selectedOptions[0]}`;
    parts.push(result.timedOut ? `${selectedText} (auto-selected after timeout)` : selectedText);
  }
  if (result.customInput !== undefined) parts.push(indented("User provided custom input:", result.customInput));
  if (result.note) {
    parts.push(indented(`User added note${result.noteOption === undefined ? "" : ` on ${result.noteOption}`}:`, result.note));
  }
  if (parts.length > 0) return parts.join("\n");
  return result.multi ? "User did not select any options" : "User cancelled the selection";
}

/** The answer for a single question, or a cancel when nothing was picked. */
function singleQuestionOutcome(result: QuestionResult): AskOutcome {
  if (!result.timedOut && !result.multi && result.selectedOptions.length === 0 && result.customInput === undefined) {
    return { kind: "cancelled" };
  }
  return {
    kind: "answered",
    text: formatSingleQuestionResponse(result),
    details: {
      question: result.question,
      options: result.options,
      multi: result.multi,
      selectedOptions: result.selectedOptions,
      customInput: result.customInput,
      note: result.note,
      noteOption: result.noteOption,
      timedOut: result.timedOut,
    },
  };
}

function multiQuestionOutcome(results: QuestionResult[]): AskOutcome {
  return {
    kind: "answered",
    text: `User answers:\n${results.map(formatQuestionResult).join("\n")}`,
    details: { results },
  };
}

/**
 * Asks every question through `select` and `editor` prompts, one at a time:
 * the sequence OMP's `ask` sent over RPC up to v18.18.2, and the one Paseo
 * maps to its question card (checkboxes for `multi`).
 */
export async function askFieldByField(
  ui: FallbackUI,
  questions: AskQuestion[],
  options: { doneLabel: string; timeout?: number; signal?: AbortSignal },
): Promise<AskOutcome> {
  const ask = (question: AskQuestion, previous?: QuestionResult, navigation?: NavigationControls) =>
    askSingleQuestion(
      ui,
      question.question,
      question.options.map((option) => ({
        label: option.label,
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      })),
      question.multi ?? false,
      {
        doneLabel: options.doneLabel,
        recommended: question.recommended,
        timeout: options.timeout,
        signal: options.signal,
        initialSelection: previous,
        navigation,
      },
    );
  const resultOf = (question: AskQuestion, selection: SelectionResult): QuestionResult => ({
    id: question.id,
    question: question.question,
    options: question.options.map((option) => option.label),
    multi: question.multi ?? false,
    selectedOptions: selection.selectedOptions,
    customInput: selection.customInput,
    note: selection.note,
    timedOut: selection.timedOut || undefined,
  });

  if (questions.length === 1) {
    const question = questions[0]!;
    const selection = await ask(question);
    if (selection.cancelled && !selection.timedOut) return { kind: "cancelled" };
    const result = resultOf(question, selection);
    // An empty multi-select is a cancel too when the field-by-field prompts ran.
    if (!selection.timedOut && result.selectedOptions.length === 0 && result.customInput === undefined) {
      return { kind: "cancelled" };
    }
    return singleQuestionOutcome(result);
  }

  const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: questions.length });
  let index = 0;
  while (index < questions.length) {
    const question = questions[index]!;
    const selection = await ask(question, resultsByIndex[index], {
      allowBack: index > 0,
      allowForward: true,
      progressText: `${index + 1}/${questions.length}`,
    });
    if (selection.cancelled && !selection.timedOut) return { kind: "cancelled" };
    resultsByIndex[index] = resultOf(question, selection);
    index = selection.navigation === "back" ? Math.max(0, index - 1) : index + 1;
  }
  return multiQuestionOutcome(
    questions.map(
      (question, i) =>
        resultsByIndex[i] ?? {
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          multi: question.multi ?? false,
          selectedOptions: [],
        },
    ),
  );
}

/** Questions in the shape of OMP's rich ask dialog (`ctx.ui.askDialog`). */
export function richDialogQuestions(questions: AskQuestion[]): AskQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    ...(question.header?.trim() ? { header: question.header } : {}),
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      ...(option.preview?.trim() ? { preview: option.preview } : {}),
    })),
    ...(question.multi !== undefined ? { multi: question.multi } : {}),
    ...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
  }));
}

export interface RichDialogResultItem {
  id: string;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  noteOption?: string;
  timedOut?: boolean;
}

export type RichDialogResult = { kind: "submit"; results: RichDialogResultItem[] } | { kind: "chat" };

/** Maps the rich ask dialog's answer to the tool outcome. */
export function richDialogOutcome(questions: AskQuestion[], result: RichDialogResult | undefined): AskOutcome {
  if (!result) return { kind: "cancelled" };
  if (result.kind === "chat") {
    const questionText = questions.map((question) => question.question).join("\n");
    return {
      kind: "answered",
      text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questionText}`,
      details: { chatRedirect: true, questions: questions.map((question) => question.question) },
    };
  }
  if (result.results.length !== questions.length) {
    throw new Error("Ask dialog returned a result count that does not match the requested questions");
  }
  const results = questions.map((question, index): QuestionResult => {
    const item = result.results[index];
    if (!item || item.id !== question.id) {
      throw new Error("Ask dialog returned results that do not match the requested question order");
    }
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multi ?? false,
      selectedOptions: item.selectedOptions,
      customInput: item.customInput,
      note: item.note,
      noteOption: item.noteOption,
      timedOut: item.timedOut,
    };
  });
  // An empty multi-select submission in the rich dialog is a valid "select none" answer.
  return questions.length === 1 ? singleQuestionOutcome(results[0]!) : multiQuestionOutcome(results);
}
