# dsh-progress-summary

[![test](https://github.com/simplenty/dsh-progress-summary/actions/workflows/test.yml/badge.svg)](https://github.com/simplenty/dsh-progress-summary/actions/workflows/test.yml)

Out-of-band progress narration for DeepSeek Harness: a cheap auxiliary model turns the live
chain of thought into one short status line, merged into the Web UI's running status row and
shown on the dsh-tui status line.

> **This repository is a fork of [tastynoob/dsh-progress-summary](https://github.com/tastynoob/dsh-progress-summary)** (MIT).
> It is maintained standalone and never opens pull requests against upstream.
> Install: `dsh plugin --profile web add github:simplenty/dsh-progress-summary`.

## Fork change: the summary lives inside the running status line

- The summary no longer renders as its own row above the composer. It is merged into the blue
  Chat running status line: `Deep diving, <summary>, for Xm Xs ···` (Chinese UI:
  `深度求索中，<摘要>，用时 X 分 X 秒 ···`).
- **The length follows each client's own row width.** On a wide desktop the summary is capped at
  20 CJK-character units; on narrow rows (under 420 px, e.g. phones) the `深度求索中，` prefix is
  dropped. The same session open on a phone and on the desktop renders independently.
- Display-only compaction strips filler openers (`目标是` / `正在` / `现在`…) and keeps the first
  clause; the full line stays available as the hover title.
- The native trailing `···` and elapsed time are preserved; the native label is restored whenever
  no summary is shown.
- Pure helpers (`compactSummary`, `composeRunningLine`, …) are exported as `inline` and covered by
  `test/inline.test.mjs`.

## Where it shows

- **Web**: merged into the Chat running status row, not a second row above the composer and not the
  transcript's process-group title.
- **dsh-tui**: the keyed status line above the prompt.
- **Switch**: Settings → General → **Show progress summary**. Turning it off cancels every
  auxiliary call and clears the TUI row immediately.
- Other knobs (model, interval, token floor, language) live on the plugin's page in Plugins.

The transcript's four work-details modes are untouched; this plugin does not add a fifth mode.

## Why out-of-band

Codex-style progress text comes from a model-side channel (`reasoning.summary` plus `commentary`
messages). DeepSeek exposes only raw `reasoning_content`, so there are two ways to approximate it:

- **Prompt nudging** (what the existing working-activity / progress-narrator plugins do): ask the
  main model to narrate each step. Cheap, but it competes with the task for output budget, and
  OpenAI's own Codex migration guide recommends removing exactly this kind of preamble prompt.
- **Out-of-band narration** (this plugin): the main model is untouched; a second, tiny request
  reads the recent reasoning and writes one line.

The cost is an extra call; the benefit is that the task never competes with its own status text.

## Trigger policy

Two layers: **free lines** update at every boundary, **model lines** fire only before a tool call.

| Trigger | Output | Cost |
|---|---|---|
| Turn start (opt-in) | "Analyzing the request" | 0 |
| Every tool call (opt-in) | a line derived from the tool name and arguments | 0 |
| **Before a tool call**, with both floors met | one sentence from the auxiliary model | 1 call |
| Turn end | idle, clearing both surfaces | 0 |

The model line requires both:

1. **Time**: at least `minIntervalMs` since the last model line (default 20s).
2. **Tokens**: at least `minTokens` of new reasoning since then (default 600; `charsPerToken`
   defaults to 3, so roughly 1800 characters).

A tool call is the only trigger that starts a model line because it is the one point where the
preceding chain of thought is known to be complete: the model has committed to an action. A pause
in the stream proves nothing (network jitter, a provider that emits two tokens and stalls, ordinary
tokenization gaps), which is why there is no timer-based trigger.

Below either floor the material stays buffered and the next tool boundary re-checks. A failed call
returns the consumed characters and retries at the next boundary. Turns without tool calls get no
model line at all — a deliberate trade: rather than cut into a reasoning block, stay quiet.

The two free rows are off by default (`quickLines: false`): the dock is a summary surface, not a
second command log. The prompt also forbids naming tools, commands, or paths, because the
transcript already shows every call.

Caps: `maxPerTurn` (default 40) calls per turn, 96 output tokens per call, `effort=off`.

## Install

### From a git tag (no registry needed)

```bash
dsh plugin --profile web add "github:tastynoob/dsh-progress-summary#v0.1.0"
dsh plugin --profile dsh-tui add "github:tastynoob/dsh-progress-summary#v0.1.0"   # optional
```

`dsh plugin add` forwards the spec to pnpm, so any pnpm git form works:
`github:user/repo#tag`, `git+https://github.com/user/repo.git#tag`, or the plain
`https://github.com/user/repo#tag`. The tag pins the version; the package has no build step, so
pnpm clones it and installs its dependencies from the registry.

### From npm (once published)

```bash
dsh plugin --profile web add dsh-progress-summary
dsh plugin --profile dsh-tui add dsh-progress-summary   # optional: TUI
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the profile's bundle
list; `cordis.patch.yml` inserts the `progress-summary` row and `dsh.client` makes the Web client
load the browser half. The plugin deliberately depends on **no DSH core package**: the session
module and the record-append function come from the Loader's own module instance at runtime, so
installing it can never shadow the host's core packages with different versions.

Remove with `dsh plugin --profile web remove dsh-progress-summary`.

### Local development (`link:`)

```bash
npm install --omit=dev
dsh plugin --profile web add "link:$PWD"
```

`link:` is a development convenience: the profile holds a symlink, so a source edit plus a restart
is enough. It has no bearing on publishing.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; also the Settings toggle (live) |
| `provider` / `model` | `auto` | `auto` follows the session's own route; otherwise pin a route |
| `effort` | `off` | Reasoning effort for the auxiliary call |
| `maxTokens` | `96` | Output cap for one line |
| `timeoutMs` | `8000` | Abort a single call after this long |
| `minIntervalMs` | `20000` | Time floor between two model lines (live) |
| `minTokens` | `600` | Token floor at a tool boundary (live) |
| `charsPerToken` | `3` | Divisor used for the token estimate |
| `excerptChars` | `700` | Reasoning tail sent to the model |
| `maxLineChars` | `128` | Hard cap for the rendered line (characters) |
| `maxPerTurn` | `40` | Hard cap on auxiliary calls per turn (live) |
| `lang` | `auto` | `auto` follows the host locale; `zh` / `en` pin it |
| `publish` | `true` | Commit ignorable records so the Web UI receives lines |
| `tui` | `true` | Contribute the line to a composed TUI |
| `quickLines` | `false` | Opt into the free turn-start/per-tool lines |
| `subagents` | `false` | Narrate subagent sessions too |
| `debug` | `true` | Append a bounded diagnostics log under `~/.dsh/` |

Fields marked live are volatile: a save takes effect on the next tool boundary, without a restart.

## How each surface receives the line

- **Web**: the host commits `plugin:progress-summary/line` (an ignorable record, safe for resume),
  which folds into the `progressSummary` session projection. The browser reads it with
  `useProjection`; nothing is written to the model-visible history.
- **dsh-tui**: `ctx.tuiStatus.set('progress-summary', line)`, cleared at turn end. This path does
  not need the record at all.

Both profiles load the same package; only the available services differ.

## Implementation notes

- Records are committed from a microtask: `session/event` listeners run inside the session's own
  commit, where a second append is refused as re-entrant.
- The commit function is taken from the Loader entry for `@deepseek-ai/dsh-session`
  (`entry.moduleNamespace`), because path-resolved copies are separate ESM instances whose private
  `Session` brand does not match the live session objects.
- The auxiliary route defaults to the session's logged `request/header` route, so no separate
  credentials or model catalog entry is needed.
- A process that starts mid-turn (a restart while a turn is running) adopts that turn at the first
  tool boundary instead of staying silent until the next turn.

## Known limitations

- One ignorable record is committed per published line (roughly 10–20 per turn at the defaults);
  set `publish: false` to keep the log clean, at the cost of the Web line.
- Turns with no tool call produce no model line.
- The line is capped at 128 characters and rendered on at most two lines.
- A misconfigured provider/model fails silently; the UI simply has no line.

## Tests

```bash
npm test      # node --test, 35 cases
npm run check # syntax check of every runtime file
```
