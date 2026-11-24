# WDX Relief

WDX Relief reduces the everyday friction of using DeepSeek Harness. Eight features, all configured in the plugin's own settings below the bundle page (**Plugins → Installed plugins → WDX Relief**); nothing is added to the DSH Settings navigation.

![WDX Relief configuration](bundle-config.webp)

## What it does

### Next-message prediction

After a turn, grey text in the composer guesses what you are about to send. Press <kbd>Tab</kbd> to fill it in, keep typing to hide it, or press <kbd>Esc</kbd> to dismiss it. It sends the last few turns to the current default model and caches the result by session sequence; it does not write to the session log.

### The line above the input

A per-turn line that answers "what is this turn doing, and where is it", always above the composer:

- **Live progress** (on by default): after the configured interval without a reply to you (10 minutes by default), the line appears automatically with the turn number and waiting time; from then on it records one idea summary per interval in Session review — a cheap model writes what that window was solving and how far it got, with commands and parameters left out, and on failure the client-local summary is kept. Tool calls and reasoning only refresh the "no output" check; they are not replies and do not reset this timer. Windows with no model activity are skipped, so waiting for your answer or approval no longer writes an empty entry every interval, and the status chip reads **Waiting for you / Waiting for approval** during those windows. A status chip — running / no output / waiting / done / cancelled — keeps it distinct from the finished recap.
- **Background job progress** (on by default): while a job from this turn still runs after the turn ended (or while you are answering), the client jobs roster and output stream (`job.list` / `job.follow`, which never consumes the model's read) feed one "how far it got" entry per interval under that turn, updated only when the job writes something; the line keeps "background job still running · running for … · latest output …". The prompt combines session context (this turn's request, its last reply, prior progress) with each job's own progress line and last few output lines (up to six lines/600 characters for each of at most three jobs), and the cheap model explains what the job is doing, how far it has got, and whether it looks healthy; command-shaped job labels display as "bash job" so command arguments do not reach the summary. A job's entries get their own "Background job" group: the Host folds every entry sharing the same job origin, including legacy rows, under one stable job id. The local summary keeps the request prefix as fallback; without the client jobs service the section stays off.
- **Semantic recap** (on by default): a cheap model summarizes the latest turn every turn. The Host takes the snapshot and generates it at `turn/end`, so a turn is recorded even when the panel is closed, you switched sessions, or the page reloaded; a client request for the same turn shares that one model call.
- **Activity feed**: generated locally with zero model calls, off by default.

The line never enters the model context; recaps and progress entries are kept in Session review in the WDX Relief panel, starting from the first turn. The "›" at its end opens that tab filtered to progress.

### WDX Relief panel

A right-sidebar page with two tabs, defaulting to Session review (configurable); the session-header icon (next to WDX Git) opens it directly:

- **Session review**: entries grouped by turn, with each turn's progress entries and recap together; the collapsible header shows the turn, counts, end time and turn duration. If any of the last N turns (3 by default, configurable under advanced settings) ends on a question or a "next step / you need" line, the group is marked "Follow up" and the filter can show only those turns. Switch between Newest first and Oldest first; filter by All / Summaries / Progress / Follow up; refresh every 30 seconds; confirm before clearing. Each progress row shows the cumulative window (the second entry reads "min 1–20"); the idea summary is written by the Host with a cheap model, falling back to the client-local summary when the model fails.
- **Ask aside**: a composer-style card with its own model picker. The Q&A stays in the panel — not in the session, not in the command log, not in the model context, and it does not change the main session model.

### Reply style

Length **short / standard / detailed** and style **default / professional / friendly / blunt / follow my style**, plus up to 2000 characters of custom instructions. These are prompt-level preferences: they change how a reply is expressed, not the task, the facts, or the tool permissions.

### Action-first

On by default: result and next step first, one sentence when one suffices, while keeping risks, failure conditions, and work you have already authorized.

### ELI5 mode

On by default: injects one line, "talk to me like I'm 5 by default; go deeper when I ask". Turning it off removes that line entirely.

### Tool-call leak guard

When the model writes a tool call as literal text (a `<tool_call>` / `<invoke>` envelope), the step produces no tool card, yet the turn closes as if finished, the guard detects it on the spot and injects a correction in the same turn so the model reissues the call in smaller chunks. The damaged step is voided on the model-visible surface, and a forked session gets a one-time brief telling it not to imitate broken history. At most two automatic corrections per turn by default; it can be disabled or lowered in the plugin settings under "Tool-call guard".

## Install

In the DSH sidebar, go to **Plugins → Add plugin**, enter `dsh-wdx-relief`, then enable it. From a checkout, run `dsh plugin --profile <name> add ./dsh-wdx-relief`.

## Requirements and limits

- DSH Web profile; the plugin depends on the `connection`, `sessions`, and `tools` services.
- A default model must be configured. Prediction, the semantic recap, progress summaries, and Ask aside make model calls; the activity feed and the Follow up marker do not. The tool-call guard is zero-cost until it fires, then costs at most one extra model step (bounded by the correction limit).
- Reply style is a soft prompt constraint, not a hard length limit.
- Recaps are stored locally in `$DSH_HOME/wdx-relief/recaps.json` (up to 300 entries); Clear in the panel also drops the current-turn cache, and deleting the file clears the history.
- Ask aside keeps answers in panel memory only; closing the panel or switching sessions clears them.
