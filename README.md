# WDX Relief

A small collection of features that reduce the everyday mental load of using DSH. Seven features today, and **every setting lives in this plugin's own configuration**.

> Sidebar **Plugins → Installed plugins → WDX Relief**; the configuration area is below the bundle page.
> It does not add a page to DSH's Settings navigation; every field is the plugin's own `Config`, persisted to the profile's `cordis.patch.yml` after saving.

## Features

- **Next-message prediction**: after a turn, grey text guesses what you'll send next; press <kbd>Tab</kbd> to accept. Typing hides it, <kbd>Esc</kbd> dismisses it.
- **The line above the input** (on by default): shows turn by turn "what this turn is doing and where it is". By default it shows only the semantic recap (a cheap model every few turns); activity feed, timing, and reasoning preview are generated locally with zero model calls and can be enabled as needed. Each of the four content types has its own switch, and this line never enters the model context. Generated recaps stay in the WDX Relief panel on the right.
- **WDX Relief page** (right sidebar, on by default): appears in the right sidebar's tool list just like WDX Git. It has three tabs: "Follow-ups" (default) lists things past sessions reminded you about that you haven't handled; click an item to jump back to that session, and the "×" on each clears unwanted suggestions (undoable; cleared records stay local). "Session review" looks back at every recap line generated in this session. "Ask aside" stays out of the main context.
- **Ask aside**: the tab's input is a rounded card like the composer, with a model picker for the aside at the bottom (only the model icon when narrow) and a circular send button on the right. The Q&A stays in the panel: it is not written to the session or the command log, does not enter the model context, and does not change the main session's model.
- **Reply style**: length **short / standard / detailed**; style **default / professional / friendly / blunt / follow my style**; up to 2000 characters of custom instructions.
- **Action-first** (on by default): result and next step first; one sentence when one suffices, plain-language explanations of terms; keeps risks, failure conditions, and work you've already authorized.
- **Tool-call leak guard** (on by default): when the model writes a tool call as literal text (`<tool_call>` / `<invoke>` envelope), the step produces no tool card, yet the turn closes normally, the guard detects it on the spot and injects a correction in the same turn so the model reissues the call. The damaged step is also voided on the model-visible surface, and a forked session gets a one-time brief telling it not to imitate broken history. Derived from `@irwdone/dsh-tool-call-leak-fix` (MIT). It can be switched on/off and tuned under "Tool-call guard" in the plugin settings.

## Requirements

- DSH Web profile; the plugin depends on the `connection`, `sessions`, and `tools` services.
- A default model configured. Prediction sends the last few turns to the current default model as a prompt; Ask aside uses the current session model by default and can be switched to another model at the bottom of the panel; Follow-ups sends one tail fragment from recent sessions for a merge decision. None of the three writes to the session log or triggers the agent loop.
- The semantic recap updates every 3 turns by default: it tries your configured cheap-model chain first, then picks a cheap model automatically, then falls back to the current default model; on model failure it falls back to a local short concatenation. Activity feed, timing, and reasoning preview make no model calls.

## Install

In the DSH sidebar, go to **Plugins → Add plugin** and enter:

```text
dsh-wdx-relief
```

Or have the agent call:

```text
plugin_manager install_bundle target = "dsh-wdx-relief"
```

Or from the command line:

```bash
dsh plugin --profile <profile> add dsh-wdx-relief
```

Enable it after installing; the client module mounts on the next page load.

For local development with a `link:` install of the current directory, see [docs/guide.md](docs/guide.md).

## Development

```bash
pnpm install
pnpm test
```

For the full config fields, implementation details, standalone web-profile install, and on-device verification records, see [docs/guide.md](docs/guide.md).
