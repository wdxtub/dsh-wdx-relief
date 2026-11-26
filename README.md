# WDX Relief

A small collection of features that reduce the everyday mental load of using DSH. Eight features today, and **every setting lives in this plugin's own configuration**.

> Sidebar **Plugins → Installed plugins → WDX Relief**; the configuration area is below the bundle page.
> It does not add a page to DSH's Settings navigation; every field is the plugin's own `Config`, persisted to the profile's `cordis.patch.yml` after saving.

## Features

- **Next-message prediction**: after a turn, grey text guesses what you'll send next; press <kbd>Tab</kbd> to accept. Typing hides it, <kbd>Esc</kbd> dismisses it.
- **The line above the input** (on by default): shows turn by turn "what this turn is doing and where it is", always above the composer. **Live progress** appears automatically after the configured interval without a reply to you (10 minutes by default) — tools and reasoning keep running but still count as no reply — and the chip names what the turn is doing right now (`running a command`, `reading README.md`, `thinking`, `replying`, with a count like `running a command ×5` for repeated steps; a stall says "no output for 12 min", approval names the tool, and failures carry the reason) next to the turn number and how long it has gone without replying to you; from then on it records one **idea summary** per interval in Session review: a cheap model writes what this window was solving and how far it got; the action list drops command arguments and command-shaped model output is filtered, with a local summary as fallback. Windows with no model activity are skipped — waiting for your answer, waiting for approval, or a quiet long command no longer writes a "no new output" entry every interval; the status chip says **Waiting for you / Waiting for approval** instead of "No output". **Background job progress** (on by default, `recapJobs`): while a job from this turn still runs after the turn ended (or while you are answering), its live output is read and one "how far it got" entry per interval is written under that turn, combining your request for that turn, the turn's last reply, and the job's latest output lines into a plain-language explanation of what the job is doing and how far it has got; a job's entries get their own Background job group instead of spreading across later turns, and the line keeps "background job still running · running for … · latest output …" — updated only when the job produces something, so you no longer have to ask. Status words are kept for the exceptional states only — no output, waiting for you, waiting for approval — plus the finished states, so the running chip never just says "running". The "›" at the end of the line opens Session review filtered to progress. The semantic recap makes one cheap model call per turn, and the Host generates it at turn end even when the panel is closed or you switched away, so no turn is skipped; the local activity feed makes zero calls. This line never enters the model context. Generated recaps stay in the WDX Relief panel on the right.
- **WDX Relief page** (right sidebar, on by default): appears in the right sidebar's tool list just like WDX Git, and a matching icon in the session header opens it directly. It has two tabs and defaults to "Session review" (configurable in settings). "Session review" groups entries by turn: each turn's progress entries and recap sit together, with a collapsible header showing the turn, counts, end time and turn duration; if any of the last N turns (3 by default; configurable under advanced settings) ends on a question or a "next step / you need" line it is marked "Follow up"; finished turns keep that marker while a new turn is running, and the running turn joins the check only after it ends. Switch between Newest first and Oldest first, filter by All / Summaries / Progress / Follow up, refresh every 30 seconds, and confirm before clearing. "Ask aside" stays out of the main context.
- **Ask aside**: the tab's input is a rounded card like the composer, with a model picker for the aside at the bottom (only the model icon when narrow) and a circular send button on the right. The Q&A stays in the panel: it is not written to the session or the command log, does not enter the model context, and does not change the main session's model.
- **Reply style**: length **short / standard / detailed**; style **default / professional / friendly / blunt / follow my style**; up to 2000 characters of custom instructions.
- **Action-first** (on by default): result and next step first; one sentence when one suffices; keeps risks, failure conditions, and work you've already authorized.
- **ELI5 mode** (on by default): injects one line, "talk to me like I'm 5 by default; go deeper when I ask"; turning it off removes that line entirely.
- **Tool-call leak guard** (on by default): when the model writes a tool call as literal text (`<tool_call>` / `<invoke>` envelope), the step produces no tool card, yet the turn closes normally, the guard detects it on the spot and injects a correction in the same turn so the model reissues the call. The damaged step is also voided on the model-visible surface, and a forked session gets a one-time brief telling it not to imitate broken history. Derived from `@irwdone/dsh-tool-call-leak-fix` (MIT). It can be switched on/off and tuned under "Tool-call guard" in the plugin settings.

## Requirements

- DSH Web profile; the plugin depends on the `connection`, `sessions`, and `tools` services.
- A default model configured. Prediction sends the last few turns to the current default model as a prompt; Ask aside uses the current session model by default and can be switched to another model at the bottom of the panel. None of the three writes to the session log or triggers the agent loop; the Follow up marker only reads the current session's recap entries.
- The semantic recap starts after the first user turn and updates every turn: it tries your configured cheap-model chain first, then picks a cheap model automatically, then falls back to the current default model; on model failure it falls back to a local short concatenation. The activity feed makes no model calls; progress summaries and turn recaps use the same model chain and fall back to local text on failure. Progress entries share `$DSH_HOME/wdx-relief/recaps.json` with summaries, one entry per configured interval (10 minutes by default).

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
