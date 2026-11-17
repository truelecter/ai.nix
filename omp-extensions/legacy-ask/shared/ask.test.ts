import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  askFieldByField,
  OTHER_OPTION,
  richDialogOutcome,
  validateQuestions,
  type AskQuestion,
  type FallbackUI,
  type SelectDialogOptions,
  type SelectItem,
} from "./ask.ts";

const DONE = "✔ Done selecting";

interface Prompt {
  kind: "select" | "editor";
  title: string;
  options?: string[];
  dialog?: SelectDialogOptions;
}

/** A UI that answers each prompt with the next scripted reply and records what it was shown. */
function scriptedUI(replies: ((prompt: Prompt) => string | undefined)[]): { ui: FallbackUI; prompts: Prompt[] } {
  const prompts: Prompt[] = [];
  const next = (prompt: Prompt) => {
    prompts.push(prompt);
    const reply = replies.shift();
    assert.ok(reply, `unexpected prompt: ${prompt.title}`);
    return Promise.resolve(reply(prompt));
  };
  return {
    prompts,
    ui: {
      select: (title: string, options: SelectItem[], dialog?: SelectDialogOptions) =>
        next({
          kind: "select",
          title,
          options: options.map((option) => (typeof option === "string" ? option : option.label)),
          dialog,
        }),
      editor: (title: string) => next({ kind: "editor", title }),
    },
  };
}

const pick = (label: string) => () => label;

const question = (overrides: Partial<AskQuestion> = {}): AskQuestion => ({
  id: "q",
  question: "Which?",
  options: [{ label: "A" }, { label: "B" }, { label: "C" }],
  ...overrides,
});

describe("askFieldByField", () => {
  test("multi-select toggles rows with checkbox markers until Done", async () => {
    const { ui, prompts } = scriptedUI([pick("A"), pick("C"), pick(DONE)]);
    const outcome = await askFieldByField(ui, [question({ multi: true })], { doneLabel: DONE });

    assert.deepEqual(
      prompts.map((prompt) => [prompt.title, prompt.options, prompt.dialog?.checkedIndices]),
      [
        ["Which?", ["A", "B", "C", OTHER_OPTION], []],
        ["(1 selected) Which?", ["A", "B", "C", DONE, OTHER_OPTION], [0]],
        ["(2 selected) Which?", ["A", "B", "C", DONE, OTHER_OPTION], [0, 2]],
      ],
    );
    assert.equal(prompts[0]!.dialog?.selectionMarker, "checkbox");
    assert.equal(prompts[0]!.dialog?.markableCount, 3);
    assert.deepEqual(outcome, {
      kind: "answered",
      text: "User selected: A, C",
      details: {
        question: "Which?",
        options: ["A", "B", "C"],
        multi: true,
        selectedOptions: ["A", "C"],
        customInput: undefined,
        note: undefined,
        noteOption: undefined,
        timedOut: undefined,
      },
    });
  });

  test("single select marks the recommended option and answers with its plain label", async () => {
    const { ui, prompts } = scriptedUI([pick("B (Recommended)")]);
    const outcome = await askFieldByField(ui, [question({ recommended: 1 })], { doneLabel: DONE });

    assert.deepEqual(prompts[0]!.options, ["A", "B (Recommended)", "C", OTHER_OPTION]);
    assert.equal(prompts[0]!.dialog?.initialIndex, 1);
    assert.equal(outcome.kind === "answered" && outcome.text, "User selected: B");
  });

  test("Other opens the editor with the question as its title", async () => {
    const { ui, prompts } = scriptedUI([pick(OTHER_OPTION), pick("my own")]);
    const outcome = await askFieldByField(ui, [question()], { doneLabel: DONE });

    assert.deepEqual(
      prompts.map((prompt) => [prompt.kind, prompt.title]),
      [
        ["select", "Which?"],
        ["editor", "Which?"],
      ],
    );
    assert.equal(outcome.kind === "answered" && outcome.text, "User provided custom input: my own");
  });

  test("several questions carry their position in the title and answer together", async () => {
    const { ui, prompts } = scriptedUI([pick("A"), pick("Y"), pick(DONE)]);
    const outcome = await askFieldByField(
      ui,
      [
        question({ id: "first" }),
        question({ id: "second", question: "Also?", multi: true, options: [{ label: "X" }, { label: "Y" }] }),
      ],
      { doneLabel: DONE },
    );

    assert.deepEqual(
      prompts.map((prompt) => prompt.title),
      ["Which? (1/2)", "Also? (2/2)", "(1 selected) Also? (2/2)"],
    );
    assert.equal(outcome.kind === "answered" && outcome.text, "User answers:\nfirst: A\nsecond: [Y]");
  });

  test("a dismissed prompt cancels the ask", async () => {
    const { ui } = scriptedUI([() => undefined]);
    assert.deepEqual(await askFieldByField(ui, [question()], { doneLabel: DONE }), { kind: "cancelled" });
  });

  test("a timeout picks the recommended option", async () => {
    const { ui } = scriptedUI([
      (prompt) => {
        prompt.dialog?.onTimeout?.();
        return undefined;
      },
    ]);
    const outcome = await askFieldByField(ui, [question({ recommended: 2 })], { doneLabel: DONE, timeout: 60_000 });
    assert.equal(outcome.kind === "answered" && outcome.text, "User selected: C (auto-selected after timeout)");
  });
});

describe("validateQuestions", () => {
  test("rejects reserved labels, Done on multi-select, and duplicates", () => {
    assert.match(validateQuestions([question({ options: [{ label: OTHER_OPTION }] })], DONE) ?? "", /reserved/);
    assert.match(validateQuestions([question({ multi: true, options: [{ label: DONE }] })], DONE) ?? "", /reserved/);
    assert.equal(validateQuestions([question({ options: [{ label: DONE }] })], DONE), undefined);
    assert.match(validateQuestions([question(), question()], DONE) ?? "", /ids must be unique/);
    assert.match(validateQuestions([question({ options: [{ label: "A" }, { label: "A" }] })], DONE) ?? "", /unique within/);
  });
});

describe("richDialogOutcome", () => {
  test("an empty multi-select submission is an answer, not a cancel", () => {
    const outcome = richDialogOutcome([question({ multi: true })], {
      kind: "submit",
      results: [{ id: "q", selectedOptions: [] }],
    });
    assert.equal(outcome.kind === "answered" && outcome.text, "User did not select any options");
  });

  test("an empty single-select submission cancels", () => {
    assert.deepEqual(
      richDialogOutcome([question()], { kind: "submit", results: [{ id: "q", selectedOptions: [] }] }),
      { kind: "cancelled" },
    );
  });
});
