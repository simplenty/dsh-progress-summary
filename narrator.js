/**
 * Per-session progress narrator.
 *
 * This module is deliberately dependency-free: it owns the trigger policy, the
 * prompt, and the line cleanup, and receives the model call and the publish
 * sink as injected hooks. The Cordis wiring lives in `index.js`, so the policy
 * can be tested without a DSH process.
 *
 * Policy in one sentence: summarize **at a tool boundary**, when the reasoning
 * since the last summary is big enough and the time floor allows it.
 *
 * A tool call is the one point where the preceding chain of thought is known to
 * be complete — the model has committed to an action, so no half-written
 * reasoning block is ever summarized. That is also why there is no timer: a
 * pause in the stream says nothing about completeness (network jitter, a
 * provider that emits two tokens and stalls, ordinary tokenization gaps).
 * @module dsh-progress-summary/narrator
 */

/** Hard cap on the rolling text buffer kept per session (characters). */
const BUFFER_LIMIT = 8000

/**
 * Collapse arbitrary model output to the last `limit` characters of readable
 * one-line text. Reasoning is mostly prose but may contain code fences and
 * markdown, which only add token noise to a summarizer call.
 * @param text - raw streamed reasoning/text.
 * @param limit - maximum characters to keep.
 * @returns trimmed tail with collapsed whitespace.
 */
export function tailText(text, limit) {
  const collapsed = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return collapsed.length > limit ? collapsed.slice(-limit) : collapsed
}

/**
 * Turn one model reply into the single status line a UI can render.
 *
 * Models still occasionally wrap the answer in quotes, a `进度：` prefix, a
 * bullet, or a trailing period; all of those are stripped here so the line
 * never has to be cleaned twice.
 * @param raw - raw model reply.
 * @param max - maximum characters in the line.
 * @returns the cleaned line, possibly empty.
 */
export function cleanLine(raw, max) {
  let line = String(raw ?? '')
    .split(/\r?\n/u)
    .map(part => part.trim())
    .find(part => part !== '') ?? ''
  line = line
    .replace(/\*\*/gu, '')
    .replace(/^[-*•·>]+\s*/u, '')
    .replace(/^(?:进度|状态)\s*[:：]\s*/u, '')
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/gu, '')
    .replace(/[。！？!?；;，,、]+$/gu, '')
    .replace(/[*_`]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (line.length > max) line = line.slice(0, max)
  return line
}

/**
 * System instruction for the summarizer. It is intentionally short: a long
 * rule list costs prompt tokens on every call and makes the model slower.
 * @param lang - `zh` or `en`.
 * @returns the system prompt.
 */
export function systemPrompt(lang) {
  if (lang === 'en') {
    return [
      'You are the progress narrator of a coding agent. The reader is waiting and cannot see the agent\'s internal reasoning.',
      'From the latest reasoning excerpt, write ONE plain progress line in English that says what the agent is trying to achieve and where it stands.',
      'The reader already sees every tool call in the transcript, so never name a tool, command, path or file; describe the intent and the progress instead.',
      'Rules: one sentence, at most 30 words; no quotes, markdown, prefix or trailing period; do not repeat the previous line.',
      'Output only that line.',
    ].join('\n')
  }
  return [
    '你是编码智能体的进度播报员。读者正在等结果，看不到模型的内部思考。',
    '根据"最近思考"，写一行中文进度说明：它想达成什么、现在走到哪一步。',
    '读者已经在工作步骤里看到了每次工具调用，所以不要复述工具名、命令、路径或文件名，只写目的和进展。',
    '规则：一句话，尽量不超过 100 字；不要引号、Markdown、前缀或句末标点；不要与"上一条"雷同；信息不足时写得更概括。',
    '只输出这一行。',
  ].join('\n')
}

/**
 * Build the user turn handed to the summarizer.
 *
 * The current tool call is deliberately absent: the reader already sees it in
 * the transcript, and feeding it here only tempts the model to narrate the
 * command instead of the progress.
 * @param input - previous line, reasoning excerpt, language.
 * @returns the user prompt text.
 */
export function userPrompt({ lastLine, excerpt, lang }) {
  if (lang === 'en') {
    return [
      `Previous: ${lastLine === '' ? '(none)' : lastLine}`,
      `Latest reasoning: ${excerpt === '' ? '(none)' : excerpt}`,
    ].join('\n')
  }
  return [
    `上一条：${lastLine === '' ? '（无）' : lastLine}`,
    `最近思考：${excerpt === '' ? '（无）' : excerpt}`,
  ].join('\n')
}

/** Tool name → the verb a progress line uses, per language. */
const TOOL_VERBS = {
  zh: {
    bash: '运行命令', shell: '运行命令', run_command: '运行命令',
    read: '读取文件', read_file: '读取文件', read_image: '查看图片',
    write: '写入文件', write_file: '写入文件',
    edit: '修改文件', str_replace: '修改文件', apply_patch: '修改文件',
    grep: '搜索代码', glob: '查找文件', search: '搜索代码',
    web_search: '搜索网页', web_fetch: '访问网页',
    task: '派发子任务', subagent: '派发子任务',
    todo_write: '更新计划', plan: '更新计划',
    ask_user_question: '等待你的回答',
  },
  en: {
    bash: 'running', shell: 'running', run_command: 'running',
    read: 'reading', read_file: 'reading', read_image: 'viewing',
    write: 'writing', write_file: 'writing',
    edit: 'editing', str_replace: 'editing', apply_patch: 'editing',
    grep: 'searching', glob: 'searching', search: 'searching',
    web_search: 'searching the web', web_fetch: 'opening',
    task: 'delegating', subagent: 'delegating',
    todo_write: 'updating the plan', plan: 'updating the plan',
    ask_user_question: 'waiting for you',
  },
}

/**
 * A free, instant progress line for one tool call — no model request.
 *
 * This is the guarantee that *something* moves even when the auxiliary call is
 * slow, misconfigured, or fails: the line comes purely from the tool name and
 * its argument preview.
 * @param name - tool name.
 * @param args - raw argument JSON.
 * @param lang - `zh` or `en`.
 * @param limit - maximum characters in the line.
 * @returns the line, or an empty string when the call has no name.
 */
export function quickToolLine(name, args, lang, limit) {
  const tool = String(name ?? '').trim()
  if (tool === '') return ''
  const verbs = TOOL_VERBS[lang] ?? TOOL_VERBS.zh
  const verb = verbs[tool] ?? verbs[tool.toLowerCase()] ?? (lang === 'en' ? 'working' : '处理中')
  const detail = toolLabel(tool, args, 60).slice(tool.length).trim()
  const head = lang === 'en' ? verb : `正在${verb}`
  const line = detail === '' ? head : `${head} · ${detail}`
  return line.length > limit ? line.slice(0, limit) : line
}

/**
 * One tool call rendered for the prompt: name plus a short argument preview.
 * @param name - tool name.
 * @param args - raw JSON argument string.
 * @param limit - maximum characters of the preview.
 * @returns `name preview`, or an empty string without a name.
 */
export function toolLabel(name, args, limit) {
  const tool = String(name ?? '').trim()
  if (tool === '') return ''
  let detail = ''
  try {
    const parsed = JSON.parse(String(args ?? ''))
    detail = String(
      parsed?.command
      ?? parsed?.file_path
      ?? parsed?.path
      ?? parsed?.query
      ?? parsed?.description
      ?? '',
    )
  } catch {
    // Unparsable arguments: keep the raw head instead of dropping the detail.
    detail = String(args ?? '')
  }
  detail = tailText(detail, limit)
  return detail === '' ? tool : `${tool} ${detail}`
}

/**
 * The narrator's timing knobs (already defaulted by the caller).
 * @typedef {object} NarratorConfig
 * @property {number} minIntervalMs - minimum gap between two summaries.
 * @property {number} minTokens - estimated tokens of new reasoning required.
 * @property {number} charsPerToken - divisor used for that estimate.
 * @property {number} excerptChars - reasoning tail sent to the model.
 * @property {number} maxLineChars - hard cap for the rendered line.
 * @property {number} maxPerTurn - hard cap on model calls per turn.
 * @property {'zh' | 'en'} lang - output language.
 */

/**
 * One session's narrator. The owner calls the `note*` methods from host events
 * and supplies `callModel` / `publish`; every failure path is swallowed so a
 * progress line can never break the agent loop.
 */
export class Narrator {
  /**
   * @param {NarratorConfig} config - timing policy.
   * @param {object} hooks - injected side effects.
   * @param {(input: { system: string, user: string, signal: AbortSignal }) => Promise<string>} hooks.callModel - one auxiliary completion.
   * @param {(value: { line: string, state: 'running' | 'idle', turn: number, at: number, calls: number }) => void} hooks.publish - sink for a new line.
   */
  constructor(config, hooks) {
    this.config = config
    this.hooks = hooks
    /** @type {string} */
    this.buffer = ''
    /** @type {string} */
    this.lastLine = ''
    /** @type {number} */
    this.turn = 0
    /** @type {number} */
    this.calls = 0
    /** @type {number} */
    this.lastAt = 0
    /** @type {number} */
    this.dirty = 0
    /** @type {number} */
    this.lastSummaryAt = 0
    /** Wall clock of the last *model* summary; free quick lines never advance it. */
    this.lastModelAt = 0
    /** @type {boolean} */
    this.running = false
    /** @type {boolean} */
    this.inFlight = false
    /** @type {boolean} */
    this.pending = false
    /** @type {AbortController | undefined} */
    this.controller = undefined
    /** @type {boolean} */
    this.active = false
  }

  /**
   * Start a turn: reset the per-turn budget and buffer.
   * @param turn - turn number from `turn/start`.
   */
  beginTurn(turn) {
    this.turn = Number(turn ?? 0)
    this.calls = 0
    this.dirty = 0
    this.lastSummaryAt = 0
    this.lastModelAt = 0
    this.buffer = ''
    this.lastLine = ''
    this.lastAt = 0
    this.active = true
  }

  /**
   * Record streamed model output (reasoning or assistant text).
   * @param text - one streamed delta.
   */
  noteText(text) {
    const part = String(text ?? '')
    if (part === '') return
    this.buffer += part
    if (this.buffer.length > BUFFER_LIMIT) this.buffer = this.buffer.slice(-BUFFER_LIMIT)
    this.dirty += part.length
    // Only a tool boundary decides; deltas just record material.
  }

  /**
   * Record a tool call about to run. The model has just finished a reasoning
   * block, so this is the highest-value moment for a line.
   * @param name - tool name.
   * @param args - raw argument JSON.
   */
  noteTool(name, args) {
    if (!this.active) return
    if (this.config.quickLines) {
      const quick = quickToolLine(name, args, this.config.lang, this.config.maxLineChars)
      if (quick !== '' && quick !== this.lastLine) {
        this.lastLine = quick
        this.publish(quick, 'running')
      }
    }
    void this.maybeRun()
  }

  /**
   * Close the turn: drop pending work, abort the request, and publish `idle`.
   * The idle record is what makes both surfaces hide the row.
   */
  endTurn() {
    if (!this.active && this.lastLine === '') return
    this.active = false
    this.controller?.abort()
    this.controller = undefined
    this.inFlight = false
    this.pending = false
    this.buffer = ''
    this.dirty = 0
    this.lastLine = ''
    this.publish('', 'idle')
  }

  /** Release timers and any in-flight request. */
  dispose() {
    this.active = false
    this.controller?.abort()
    this.controller = undefined
  }

  /**
   * Decide whether this tool boundary earns a summary.
   *
   * Two independent gates: the time floor (`minIntervalMs`) and the material
   * floor (`minTokens`, estimated from characters). When either is short, the
   * material stays buffered and the next tool boundary re-checks — nothing is
   * lost, and no call is made for a partial reasoning block.
   */
  maybeRun() {
    if (!this.active || this.inFlight) return
    if (this.calls >= this.config.maxPerTurn) return
    const now = Date.now()
    if (this.lastModelAt !== 0 && now - this.lastModelAt < this.config.minIntervalMs) return
    const tokens = Math.ceil(this.dirty / Math.max(1, this.config.charsPerToken))
    if (tokens < this.config.minTokens) return
    void this.run()
  }

  /** Fire one summarizer call, staying inside the per-turn budget. */
  async run() {
    if (!this.active) return
    if (this.inFlight) {
      this.pending = true
      return
    }
    if (this.calls >= this.config.maxPerTurn) return
    // A tool-only boundary (no reasoning before the call) has nothing to
    // summarize; the transcript already shows the call itself.
    const excerpt = tailText(this.buffer, this.config.excerptChars)
    if (excerpt === '') return
    this.inFlight = true
    this.calls += 1
    // Consume the material this call sees; text that arrives during the call
    // counts toward the next decision.
    const consumedChars = this.dirty
    this.dirty = 0
    this.lastSummaryAt = Date.now()
    this.lastModelAt = this.lastSummaryAt
    const controller = new AbortController()
    this.controller = controller
    try {
      const raw = await this.hooks.callModel({
        system: systemPrompt(this.config.lang),
        user: userPrompt({ lastLine: this.lastLine, excerpt, lang: this.config.lang }),
        signal: controller.signal,
      })
      if (!this.active || controller.signal.aborted) return
      const line = cleanLine(raw, this.config.maxLineChars)
      if (line === '' || line === this.lastLine) return
      this.lastLine = line
      this.publish(line, 'running')
    } catch {
      // A failed narrator call is not an agent failure: keep the previous line.
      this.dirty += consumedChars
    } finally {
      if (this.controller === controller) this.controller = undefined
      this.inFlight = false
      this.pending = false
    }
  }

  /**
   * Emit one value through the publish hook.
   * @param line - rendered line.
   * @param state - `running` or `idle`.
   */
  publish(line, state) {
    this.lastAt = Date.now()
    try {
      this.hooks.publish({
        line,
        state,
        turn: this.turn,
        at: this.lastAt,
        calls: this.calls,
      })
    } catch {
      // The sink is best-effort by contract.
    }
  }
}
