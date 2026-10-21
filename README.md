# dsh-progress-summary

Out-of-band progress narration for DeepSeek Harness: a cheap auxiliary model turns the live
chain of thought into one short status line, shown above the composer in the Web UI and on the
dsh-tui status line.

## Where it shows

- **Web**: the row above the composer (the input dock), not the transcript's process rows.
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
| Turn start | "Analyzing the request" | 0 |
| Every tool call | "running · npm test" derived from the tool name and arguments | 0 |
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

Caps: `maxPerTurn` (default 40) calls per turn, 96 output tokens per call, `effort=off`.

## Install

### From npm (once published)

```bash
dsh plugin --profile web add dsh-progress-summary
dsh plugin --profile dsh-tui add dsh-progress-summary   # optional: TUI
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the profile's bundle
list; `cordis.patch.yml` inserts the `progress-summary` row and `dsh.client` makes the Web client
load the browser half. Dependencies (`@deepseek-ai/dsh-session`, `dsh-llm`, `schemastery`) are
installed into the profile by pnpm.

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
| `quickLines` | `true` | Publish the free per-tool line |
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
