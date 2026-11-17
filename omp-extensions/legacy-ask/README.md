# legacy-ask (OMP extension)

Brings back the question-based `ask` tool of [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) up to v18.18.2, in place of the HTML-form `ask` that replaced it in v18.18.3.

## Why

Paseo maps OMP's `ask` to its question card by reading the tool call's `questions[]` arguments and the `select` prompts OMP sends for them (`packages/server/src/server/agent/providers/omp/question-ui.ts`). The HTML-form `ask` has an `html` argument instead, so Paseo (0.16 and `main` as of 2026-11-17) shows every field as a plain single-pick list: checkbox groups lose their checkboxes and multi-select, and the "Done selecting" row turns into an option. This extension re-registers `ask` with the old schema and the old prompt sequence, which Paseo matches again. Drop it once Paseo handles the HTML-form `ask`.

## What it does

- Registers `ask` (same name, so it replaces the built-in) with the old parameters: `questions[]` of `{id, question, header?, options[{label, description?, preview?}], multi?, recommended?}`, and the old tool description.
- Where OMP offers the rich ask dialog (`ctx.ui.askDialog`: the interactive TUI, RPC hosts that sent `set_ask_dialog`), it shows that dialog, including "Chat about this" and option notes.
- Elsewhere (Paseo and other RPC hosts) it walks the questions one prompt at a time, as OMP did:
  - single choice: one `select` with the options, the recommended one marked " (Recommended)", and "Other (type your own)";
  - `multi: true`: a `select` per toggle, titled `(N selected) <question>`, with "Done selecting" once something is checked and the checkbox state in `selectionMarker`/`checkedIndices`;
  - "Other" opens an `editor` titled with the question;
  - several questions add ` (i/N)` to each title.
- Answers come back as before (`User selected: ...`, `User answers:\n<id>: ...`) with the old result details (`question`, `selectedOptions`, `customInput`, `results`), which Paseo's tool row and beautiful-chat's Ask card read.
- Follows `ask.timeout` (none in plan mode) and `ask.notify` (terminal notification, TUI only).
- A dismissed prompt cancels the ask and aborts the run. If a chat message is waiting (Paseo sends one as a steer and closes the prompt), the call ends with "Ask interrupted by message" instead, and the message reaches the agent.
- Removes `ask` from sessions without a UI (print mode, headless RPC, subagents), where OMP doesn't offer the built-in either.

Not ported: images pasted into answers, speaking the questions (`speech.enabled`), the TUI renderer of the old tool (calls show with OMP's default rendering), and running alone in a tool batch (extension tools can't declare `concurrency`).

## Install

Packaged as `pkgs.omp-extensions.legacy-ask` (flake output `omp-extension-legacy-ask`). Enable it through the Home Manager module; OMP loads it on the next session start:

```nix
programs.oh-my-pi.extensions = [pkgs.omp-extensions.legacy-ask];
```

## Smoke test

Run OMP with `--mode rpc-ui -e <this folder>` (see the repository's `AGENTS.md` for an isolated agent directory) and prompt for an `ask` with `multi: true`. The `extension_ui_request` frames should be `select` with title `Pick colors` and options `Red, Green, Blue, Other (type your own)`, then `(1 selected) Pick colors` with a `Done selecting` row and `checkedIndices: [0]`; answering the Done row gives `User selected: Red, ...`.

## Layout

- `index.ts`: registers the tool, reads the settings, picks the rich dialog or the field-by-field prompts, turns cancels into aborts.
- `shared/ask.ts`: the ported logic (validation, prompt sequence, answer texts), with no OMP imports, tested in `shared/ask.test.ts`.
- `types/omp.d.ts`: minimal types for the OMP modules used here (`@oh-my-pi/pi-coding-agent`, its `config/registry`, `@oh-my-pi/pi-tui` for `TERMINAL` and `theme`). OMP provides them at runtime.

## Develop

`nix build .#omp-extension-legacy-ask` runs the tests. Type checks, from this folder:

```sh
bun install
bun run typecheck
bun run test
```
