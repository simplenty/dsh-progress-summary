/**
 * dsh-progress-summary — an out-of-band progress narrator for DeepSeek Harness.
 *
 * Codex-style progress text does not come from prompting the main agent: the
 * main model's task is the task, and asking it to also narrate steals output
 * budget and occasionally makes it stop early. This plugin keeps the narration
 * on a separate, cheap request instead:
 *
 * 1. Watch the live assistant stream and durable tool events (no prompt changes).
 * 2. At a boundary (a finished reasoning burst, a tool about to run) ask a
 *    small model — low or no reasoning effort — for one short line.
 * 3. Publish that line as an ignorable plugin record (`progressSummary`
 *    projection, read by the Web client) and, when the TUI is composed, as a
 *    `ctx.tuiStatus` contribution.
 *
 * The auxiliary route defaults to `auto`: whatever provider/model the session
 * itself is using (captured from its logged `request/header`) is reused through
 * the ordinary `ctx.llm` service, so no extra credentials or routes are needed.
 * `provider`/`model` pin a different (usually smaller) model when preferred.
 *
 * Nothing here can fail the agent: every call is aborted on turn end and every
 * error is swallowed. The per-turn cap is the cost ceiling.
 * @module dsh-progress-summary
 */

import { appendFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Narrator } from './narrator.js'
import { createProgressProjection, PROGRESS_RECORD_TYPE } from './projection.js'

export const name = 'progress-summary'

/**
 * Collect every reachable `appendPluginRecord` implementation.
 *
 * The private-field commit behind it is brand-checked against the Session class
 * of the copy that defined it. A link-installed plugin can resolve its own
 * `@deepseek-ai/dsh-session` while the host session object belongs to the CLI
 * tree's copy, in which case that copy's function throws a private-brand error.
 * The app entry's copy is therefore tried first, and the publish path falls
 * through the list until one accepts the session object.
 * @returns {Array<(session: object, type: string, data: object) => unknown>} candidates.
 */
function appendCandidates() {
  const found = []
  const push = fn => {
    if (typeof fn === 'function' && !found.includes(fn)) found.push(fn)
  }
  for (const anchor of [process.argv[1], import.meta.url]) {
    if (typeof anchor !== 'string' || anchor === '') continue
    try {
      const require = createRequire(anchor)
      push(require('@deepseek-ai/dsh-session')?.appendPluginRecord)
    } catch {
      // That tree does not resolve the package (or refuses CJS require of ESM).
    }
  }
  push(appendPluginRecord)
  return found
}

/**
 * Find the app tree's `appendPluginRecord` without requiring ESM.
 *
 * `require()` of an ESM package can fail on a host that disables it, so the
 * path is resolved first and the module is then imported. The app entry's copy
 * is the one whose Session class owns the session objects the agent loop
 * creates; the plugin's own copy is a different class and would refuse the
 * private-field commit.
 * @param log - diagnostics sink.
 * @returns the module's function, or undefined when no app tree copy resolves.
 */
/** Resolve one anchor to the set of filesystem paths worth trying. */
function anchorVariants(input) {
  const paths = []
  if (typeof input !== 'string' || input === '') return paths
  let path = input
  if (path.startsWith('file:')) {
    try {
      path = fileURLToPath(path)
    } catch {
      return paths
    }
  }
  paths.push(path)
  try {
    const real = realpathSync(path)
    if (real !== path) paths.push(real)
  } catch {
    // A virtual or vanished anchor still gets its literal path tried.
  }
  return paths
}

async function discoverAppend(log, extraAnchors) {
  const anchors = [
    ...(Array.isArray(extraAnchors) ? extraAnchors.flatMap(anchor => anchorVariants(anchor)) : []),
    ...anchorVariants(process.argv[1]),
    // The plugin's own tree is the last resort; its Session class usually
    // belongs to a different module instance than the host's session objects.
    ...anchorVariants(import.meta.url),
  ]
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const resolved = require.resolve('@deepseek-ai/dsh-session')
      const module = await import(pathToFileURL(resolved).href)
      if (typeof module.appendPluginRecord === 'function') {
        log(`append resolved from ${resolved}`)
        return module.appendPluginRecord
      }
    } catch (error) {
      log(`append resolve failed at ${anchor}: ${error?.message?.split('\n')[0] ?? 'unknown'}`)
    }
  }
  return undefined
}

/** Where the TUI contribution is keyed; one row per process. */
const TUI_STATUS_KEY = 'progress-summary'

/**
 * `auto` means "reuse the session's own provider/model", captured from the
 * session's logged request header. Any other value pins that exact route.
 */
const AUTO = 'auto'

/**
 * Loader-facing configuration schema. Exporting it gives the Plugins page a
 * form, so the model can be changed without editing the profile YAML. Every
 * field has a default; the whole feature can be switched off without unloading
 * the row.
 */
/** Loader schema. `provider`/`model`/`effort` are volatile so the Plugins page can edit them live. */
export const Config = z.object({
  /** Master switch (volatile so Settings can toggle it live). */
  enabled: z.boolean().default(true).volatile(),
  /** Auxiliary provider route, or `auto` to follow the session's own route. */
  provider: z.string().default(AUTO).volatile(),
  /** Auxiliary model id, or `auto`. A small fast model keeps the cost down. */
  model: z.string().default(AUTO).volatile(),
  /** Reasoning effort for the auxiliary call. */
  effort: z.union(['off', 'low', 'high', 'max']).default('off').volatile(),
  /** Output cap for one line. */
  maxTokens: z.number().min(16).max(256).step(1).default(96),
  /** Abort the auxiliary call after this long. */
  timeoutMs: z.number().min(1000).max(60000).step(100).default(8_000),
  /** Minimum gap between two summaries (the time floor). */
  minIntervalMs: z.number().min(1_000).max(600_000).step(500).default(20_000).volatile(),
  /** Estimated tokens of new reasoning required at a tool boundary. */
  minTokens: z.number().min(0).max(100_000).step(50).default(600).volatile(),
  /** Characters per token used for that estimate (mixed Chinese/English ≈ 3). */
  charsPerToken: z.number().min(1).max(8).step(0.5).default(3),
  /** Reasoning tail sent to the model. */
  excerptChars: z.number().min(100).max(4000).step(50).default(700),
  /** Hard cap for the rendered line (characters, not tokens). */
  maxLineChars: z.number().min(8).max(200).step(1).default(128),
  /** Hard cap on auxiliary calls per turn. */
  maxPerTurn: z.number().min(0).max(500).step(1).default(40).volatile(),
  /** Output language; `auto` follows the host locale. */
  lang: z.union(['auto', 'zh', 'en']).default(AUTO).volatile(),
  /** Commit plugin records so the Web UI receives lines. */
  publish: z.boolean().default(true),
  /** Contribute the line to a composed TUI. */
  tui: z.boolean().default(true),
  /** Publish an instant, model-free line on every tool boundary. */
  quickLines: z.boolean().default(true),
  /** Append a bounded diagnostics log under the harness home. */
  debug: z.boolean().default(true),
})/** Defaults, used when the loader passes an incomplete object. */
const DEFAULTS = {
  enabled: true,
  provider: AUTO,
  model: AUTO,
  effort: 'off',
  maxTokens: 96,
  timeoutMs: 8_000,
  minIntervalMs: 20_000,
  minTokens: 600,
  charsPerToken: 3,
  excerptChars: 700,
  maxLineChars: 128,
  maxPerTurn: 40,
  lang: AUTO,
  publish: true,
  tui: true,
  quickLines: true,
  debug: true,
}

/** Size cap for the diagnostics log; older content is dropped by rewriting once. */
const DEBUG_LOG_LIMIT = 256 * 1024

/**
 * Create a bounded append-only diagnostics sink.
 * @param enabled - whether the caller asked for diagnostics.
 * @returns a `log(message)` function; a no-op when disabled.
 */
function createDebugLog(enabled) {
  if (!enabled) return () => {}
  const path = join(homedir(), '.dsh', 'progress-summary-debug.log')
  try {
    writeFileSync(path, `# progress-summary ${new Date().toISOString()}\n`)
  } catch {
    return () => {}
  }
  return message => {
    try {
      if (statSync(path).size > DEBUG_LOG_LIMIT) return
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // Diagnostics must never disturb the agent.
    }
  }
}

/**
 * Read one configuration value that may be a live volatile reference.
 *
 * Fields marked `.volatile()` are delivered by the loader as references whose
 * `.get()` reflects the latest committed settings, so the value must be read at
 * use time rather than snapshotted when the plugin mounts.
 * @param value - plain value or volatile reference.
 * @param fallback - value used when the reference is absent.
 * @returns the current plain value.
 */
function readRef(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined ? fallback : current
  }
  return value === undefined ? fallback : value
}

/**
 * Coerce one numeric setting into its bounds.
 * @param value - candidate value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used when the candidate is not a finite number.
 * @returns the bounded number.
 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

/**
 * Resolve the output language once per load.
 * @param {'auto' | 'zh' | 'en'} setting - configured value.
 * @returns {'zh' | 'en'} concrete language.
 */
function resolveLang(setting) {
  if (setting === 'zh' || setting === 'en') return setting
  const env = process.env.DSH_TUI_LANG ?? process.env.LANG ?? ''
  return /^zh/iu.test(env) ? 'zh' : 'en'
}

/**
 * Normalize untrusted loader configuration over the defaults.
 * @param {object} raw - loader-supplied config.
 * @returns {object} resolved config.
 */
function resolveConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) }
  const clamp = (value, min, max, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
  }
  const route = (value, fallback) => {
    const text = String(value ?? '').trim()
    return text === '' ? fallback : text
  }
  return {
    enabled: merged.enabled !== false,
    provider: AUTO,
    model: AUTO,
    effort: DEFAULTS.effort,
    maxTokens: Math.round(clamp(merged.maxTokens, 16, 256, DEFAULTS.maxTokens)),
    timeoutMs: Math.round(clamp(merged.timeoutMs, 1_000, 60_000, DEFAULTS.timeoutMs)),
    minIntervalMs: Math.round(clamp(readRef(merged.minIntervalMs, DEFAULTS.minIntervalMs), 0, 600_000, DEFAULTS.minIntervalMs)),
    minTokens: Math.round(clamp(readRef(merged.minTokens, DEFAULTS.minTokens), 0, 100_000, DEFAULTS.minTokens)),
    charsPerToken: clamp(merged.charsPerToken, 1, 8, DEFAULTS.charsPerToken),
    excerptChars: Math.round(clamp(merged.excerptChars, 100, 4_000, DEFAULTS.excerptChars)),
    maxLineChars: Math.round(clamp(merged.maxLineChars, 8, 200, DEFAULTS.maxLineChars)),
    maxPerTurn: Math.round(clamp(readRef(merged.maxPerTurn, DEFAULTS.maxPerTurn), 0, 500, DEFAULTS.maxPerTurn)),
    lang: resolveLang(merged.lang),
    publish: merged.publish !== false,
    tui: merged.tui !== false,
    quickLines: merged.quickLines !== false,
    debug: merged.debug !== false,
  }
}

/**
 * Wire the narrator into one DSH process.
 * @param {object} ctx - Cordis context with the agent loop composed.
 * @param {object} [raw] - loader configuration.
 */
export function apply(ctx, raw = {}) {
  const config = resolveConfig(raw)
  const log = createDebugLog(config.debug)
  log(`apply provider=${readRef(raw.provider, AUTO)} model=${readRef(raw.model, AUTO)} `
    + `effort=${readRef(raw.effort, DEFAULTS.effort)} publish=${config.publish} `
    + `tui=${config.tui} quick=${config.quickLines} interval=${config.minIntervalMs}`)

  /** @type {any} */
  let llm
  /** @type {any} */
  let tuiStatus

  ctx.inject(['llm'], (llmCtx) => {
    llm = llmCtx.llm
  })

  // The TUI is optional: a Web-only profile never composes `tuiStatus`, and a
  // TUI-only profile never composes the projection registry.
  if (config.tui) {
    ctx.inject(['tuiStatus'], (tuiCtx) => {
      tuiStatus = tuiCtx.tuiStatus
      tuiCtx.effect(() => () => {
        if (tuiStatus !== tuiCtx.tuiStatus) return
        try {
          tuiStatus.set(TUI_STATUS_KEY, undefined, ctx)
        } catch {
          // The TUI may already be tearing down; nothing to clear.
        }
        tuiStatus = undefined
      })
    })
  }

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createProgressProjection())
  })

  /** @type {Map<object, { narrator: Narrator, session: any, turn: number, route?: { provider: string, model: string } }>} */
  const runtimes = new Map()

  /** Implementations to try, plus the one that last accepted this process's sessions. */
  const appends = appendCandidates()
  let preferredAppend

  // Resolve the app tree's copy in the background; it is normally ready long
  // before the first turn boundary.
  // Every loader entry's base URL is a candidate: the bundle that created the
  // session resolves dsh-session from its own tree, which may not be the CLI's.
  const loaderAnchors = []
  try {
    const loader = ctx.get('loader', false)
    for (const entry of loader?.entries?.() ?? []) {
      const base = entry?.parent?.tree?.ctx?.baseUrl
      if (typeof base === 'string' && base !== '') loaderAnchors.push(base)
    }
  } catch {
    // No loader in this composition.
  }
  log(`baseUrl=${String(ctx.baseUrl)} anchors=${loaderAnchors.length}`)

  // The Loader imported `@deepseek-ai/dsh-session` itself to mount the `session`
  // row, and Entry keeps that module namespace. It is the exact instance whose
  // Session class owns the live session objects — no path resolution can beat it.
  try {
    for (const entry of ctx.get('loader', false)?.entries?.() ?? []) {
      if (entry?.options?.name !== '@deepseek-ai/dsh-session') continue
      const namespace = entry.moduleNamespace
      const fn = namespace?.appendPluginRecord
      log(`session row namespace append=${typeof fn}`)
      if (typeof fn === 'function' && !appends.includes(fn)) appends.unshift(fn)
    }
  } catch (error) {
    log(`session row probe failed: ${error?.message ?? 'unknown'}`)
  }

  void discoverAppend(log, [ctx.baseUrl, ...loaderAnchors]).then(fn => {
    if (fn === undefined) return
    const index = appends.indexOf(fn)
    if (index !== -1) appends.splice(index, 1)
    appends.unshift(fn)
  })

  /**
   * The canonical Session instance for one event's session argument.
   *
   * `session/event` listeners may receive a scoped proxy rather than the store's
   * own instance, and a proxy fails every private-field brand check. Resolving
   * the store's instance makes the plugin-record commit possible again.
   * @param session - session as delivered by the event.
   * @returns the store instance when available, otherwise the argument.
   */
  const canonicalSession = session => {
    try {
      const store = ctx.get('sessions', false)
      if (store !== undefined && typeof store.get === 'function') {
        const found = store.get(session?.id)
        if (found !== undefined) return found
      }
    } catch {
      // No session store: use what the event delivered.
    }
    return session
  }

  /**
   * Commit one ignorable plugin record through whichever copy owns the session.
   * @param session - host session object.
   * @param type - `plugin:` record type.
   * @param data - JSON payload.
   * @returns {boolean} whether a copy accepted it.
   */
  const appendRecord = (session, type, data) => {
    const order = preferredAppend === undefined
      ? appends
      : [preferredAppend, ...appends.filter(fn => fn !== preferredAppend)]
    let lastError
    const targets = [canonicalSession(session), session]
    for (const target of targets) {
      for (const fn of order) {
        try {
          fn(target, type, data)
          preferredAppend = fn
          return true
        } catch (error) {
          // Wrong copy for this session, or the session is closed: try the next.
          lastError = error
        }
      }
    }
    let kind = 'object'
    try {
      kind = types.isProxy(session) ? 'proxy' : 'plain'
    } catch {
      // Leave the description generic.
    }
    log(`append failed for all ${order.length} candidates: ${lastError?.message ?? 'unknown error'} `
      + `(session class ${session?.constructor?.name ?? '?'}, ${kind}, id ${String(session?.id ?? '?')})`)
    return false
  }

  /**
   * Publish one narrator value to every compiled surface.
   * @param session - owning session.
   * @param value - narrator value.
   */
  const publish = (session, value) => {
    if (!liveEnabled()) {
      if (tuiStatus !== undefined) {
        try {
          tuiStatus.set(TUI_STATUS_KEY, undefined, ctx)
        } catch {
          // Status contributions are best-effort by contract.
        }
      }
      return
    }
    if (config.publish) {
      const payload = {
        line: value.line,
        state: value.state,
        turn: value.turn,
        at: value.at,
        calls: value.calls,
      }
      // `session/event` listeners run inside the session's own commit, and a
      // second append while one is being published is refused. Deferring by a
      // microtask commits right after the current event settles.
      queueMicrotask(() => {
        const ok = appendRecord(session, PROGRESS_RECORD_TYPE, payload)
        log(`publish record ok=${ok} state=${payload.state} line=${JSON.stringify(payload.line)}`)
      })
    }
    if (tuiStatus !== undefined) {
      try {
        tuiStatus.set(
          TUI_STATUS_KEY,
          value.state === 'running' && value.line !== '' ? value.line : undefined,
          ctx,
        )
      } catch (error) {
        // Status contributions are best-effort by contract.
        log(`tuiStatus.set failed: ${error?.message ?? 'unknown error'}`)
      }
    }
  }

  /**
   * Read the aux route from the live configuration. Volatile references make
   * a save on the Plugins page take effect on the next summary, without a
   * remount or restart.
   * @returns {{ provider: string, model: string, effort: string }} configured route.
   */
  const liveRoute = () => {
    const effort = readRef(raw.effort, DEFAULTS.effort)
    return {
      provider: String(readRef(raw.provider, AUTO)).trim() || AUTO,
      model: String(readRef(raw.model, AUTO)).trim() || AUTO,
      effort: ['off', 'low', 'high', 'max'].includes(effort) ? effort : DEFAULTS.effort,
    }
  }

  /**
   * Read the trigger policy from the live configuration.
   * @returns {{ minIntervalMs: number, minTokens: number, maxPerTurn: number }} policy.
   */
  /**
   * Whether the summary is switched on right now.
   * @returns {boolean} the live master switch.
   */
  const liveEnabled = () => readRef(raw.enabled, true) !== false

  const livePolicy = () => ({
    minIntervalMs: Math.round(clampNumber(readRef(raw.minIntervalMs, DEFAULTS.minIntervalMs), 0, 600_000, DEFAULTS.minIntervalMs)),
    minTokens: Math.round(clampNumber(readRef(raw.minTokens, DEFAULTS.minTokens), 0, 100_000, DEFAULTS.minTokens)),
    maxPerTurn: Math.round(clampNumber(readRef(raw.maxPerTurn, DEFAULTS.maxPerTurn), 0, 500, DEFAULTS.maxPerTurn)),
    lang: resolveLang(readRef(raw.lang, AUTO)),
  })

  /**
   * The route one auxiliary call should use: the configured override, or the
   * session's own logged route while everything is `auto`.
   * @param {{ provider: string, model: string } | undefined} sessionRoute - route captured from `request/header`.
   * @returns {{ provider: string, model: string } | undefined} effective route.
   */
  const effectiveRoute = sessionRoute => {
    const current = liveRoute()
    const provider = current.provider === AUTO ? sessionRoute?.provider : current.provider
    const model = current.model === AUTO ? sessionRoute?.model : current.model
    if (provider === undefined || model === undefined) return undefined
    return { provider, model }
  }

  /**
   * One auxiliary completion, bounded by config.timeoutMs and the narrator's
   * own abort signal.
   * @param {object} input - prompt and route.
   * @param {string} input.system - system prompt.
   * @param {string} input.user - user prompt.
   * @param {AbortSignal} input.signal - cancellation.
   * @param {{ provider: string, model: string }} input.route - exact route.
   * @returns {Promise<string>} accumulated text output.
   */
  const callModel = async ({ system, user, signal, route }) => {
    if (!liveEnabled()) return ''
    if (llm === undefined) {
      log('callModel skipped: llm service not ready')
      return ''
    }
    if (route === undefined) {
      log('callModel skipped: no route yet (waiting for request/header)')
      return ''
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), config.timeoutMs)
    timer.unref?.()
    const onAbort = () => timeout.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const call = await prepareWithEffort(llm, route, timeout.signal)
      log(`prepareCall ok ${route.provider}/${route.model}`)
      const messages = [
        createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'progress-summary' },
        }),
      ]
      let text = ''
      for await (const chunk of call.stream({
        ...call.config,
        messages,
        system,
        signal: timeout.signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (timeout.signal.aborted) break
      }
      log(`stream done chars=${text.length}`)
      return text
    } catch (error) {
      log(`callModel failed: ${error?.message ?? 'unknown error'}`)
      return ''
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Prepare the auxiliary call, dropping reasoning effort when the route does
   * not accept the configured value (older adapters and some models do not).
   * @param llmService - the LLM runtime.
   * @param route - effective provider/model.
   * @param signal - abort signal.
   * @returns {Promise<any>} a prepared call.
   */
  const prepareWithEffort = async (llmService, route, signal) => {
    const base = { provider: route.provider, model: route.model, maxTokens: config.maxTokens }
    try {
      return await llmService.prepareCall(base, signal, controls => ({
        ...controls,
        reasoningEffort: liveRoute().effort,
      }))
    } catch {
      return await llmService.prepareCall(base, signal)
    }
  }

  /**
   * Read or create the runtime for one session.
   * @param session - session object.
   * @returns {object} the runtime.
   */
  const runtimeFor = (session) => {
    let runtime = runtimes.get(session)
    if (runtime !== undefined) return runtime
    runtime = { session, turn: 0, route: undefined }
    const narrator = new Narrator(
      {
        minIntervalMs: config.minIntervalMs,
        minTokens: config.minTokens,
        charsPerToken: config.charsPerToken,
        excerptChars: config.excerptChars,
        maxLineChars: config.maxLineChars,
        maxPerTurn: config.maxPerTurn,
        lang: config.lang,
        quickLines: config.quickLines,
      },
      {
        callModel: input => callModel({ ...input, route: effectiveRoute(runtime.route) }),
        publish: value => publish(session, value),
      },
    )
    runtime.narrator = narrator
    runtimes.set(session, runtime)
    return runtime
  }

  ctx.on('session/event', (session, event) => {
    const runtime = runtimes.get(session)
    switch (event.type) {
      case 'turn/start': {
        const turn = Number(event.data?.turn ?? 0)
        const target = runtime ?? runtimeFor(session)
        target.turn = turn
        Object.assign(target.narrator.config, livePolicy())
        target.narrator.beginTurn(turn)
        log(`turn/start ${turn}`)
        if (config.quickLines) {
          // Never leave the reader with an empty status while the model thinks.
          publish(session, {
            line: livePolicy().lang === 'en' ? 'Analyzing the request' : '正在分析需求',
            state: 'running',
            turn,
            at: Date.now(),
            calls: 0,
          })
        }
        return
      }
      case 'request/header': {
        // The session's own route is the default auxiliary route: `auto` then
        // means "summarize with whatever model this conversation runs on".
        const header = event.data?.header
        const provider = header?.config?.provider
        const model = header?.config?.model
        if (typeof provider === 'string' && typeof model === 'string') {
          const target = runtimeFor(session)
          const changed = target.route?.provider !== provider || target.route?.model !== model
          target.route = { provider, model }
          if (changed) log(`route ${provider}/${model}`)
        }
        return
      }
      case 'tool/call': {
        if (!liveEnabled()) return
        if (runtime === undefined) {
          log(`tool/call without runtime: ${String(event.data?.name)}`)
          return
        }
        log(`tool ${String(event.data?.name)}`)
        Object.assign(runtime.narrator.config, livePolicy())
        runtime.narrator.noteTool(event.data?.name, event.data?.arguments)
        return
      }
      case 'turn/end': {
        if (runtime === undefined) return
        runtime.narrator.endTurn()
        return
      }
      default:
    }
  })

  ctx.on('agent/assistant-stream', payload => {
    if (!liveEnabled()) return
    const session = payload?.agent?.session
    if (session === undefined) return
    const frame = payload.frame
    if (frame?.type !== 'chunk' || frame.chunk === undefined) return
    const chunk = frame.chunk
    if (chunk.type !== 'reasoning-delta' && chunk.type !== 'text-delta') return
    const runtime = runtimes.get(session)
    if (runtime === undefined) return
    runtime.narrator.noteText(chunk.text)
  })

  ctx.on('session/disposed', (session) => {
    const runtime = runtimes.get(session)
    if (runtime === undefined) return
    runtime.narrator.dispose()
    runtimes.delete(session)
  })

  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) runtime.narrator.dispose()
    runtimes.clear()
  }, 'progress-summary narrator timers')
}
