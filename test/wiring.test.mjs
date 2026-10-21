import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Minimal Cordis stand-in: records event handlers and hands the injected
 * services straight to the plugin's `inject` callbacks.
 * @param services - services to expose.
 * @returns {{ ctx: object, handlers: Record<string, Function> }} fake context.
 */
function fakeCtx(services) {
  const handlers = {}
  const ctx = {
    handlers,
    on(name, handler) {
      handlers[name] = handler
    },
    inject(deps, callback) {
      callback({
        ...services,
        effect(factory) {
          return factory()
        },
      })
    },
    effect(factory) {
      return factory()
    },
    get() {
      return undefined
    },
  }
  return { ctx, handlers }
}

/** Config that makes every tool boundary eligible: no floors, 1 char ≈ 1 token. */
const ready = { minIntervalMs: 0, minTokens: 1, charsPerToken: 1, lang: 'zh' }

/**
 * Drive one step's reasoning followed by a tool call.
 * @param handlers - recorded host handlers.
 * @param session - fake session object.
 * @param tool - tool name to call.
 */
function thinkThenCall(handlers, session, tool = 'read') {
  handlers['agent/assistant-stream']({
    agent: { session },
    frame: {
      type: 'chunk',
      chunk: { type: 'reasoning-delta', text: '我需要先读取配置文件，确认端口号。' },
    },
  })
  handlers['session/event'](session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-1', name: tool, arguments: '{"file_path":"config.ts"}' },
  })
}

test('a tool boundary publishes the model line and registers the projection', async () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const registered = []
  const llm = {
    async prepareCall(config, signal, configure) {
      const controls = configure === undefined ? config : configure({ ...config }, {})
      return {
        config: { ...config, ...controls },
        async *stream() {
          yield { type: 'text-delta', text: '“正在读取配置文件”' }
        },
      }
    },
  }
  const { ctx, handlers } = fakeCtx({
    llm,
    sessionProjections: { register: definition => registered.push(definition) },
    tuiStatus: tui,
  })

  apply(ctx, ready)

  const session = { id: 'session-test' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  })
  thinkThenCall(handlers, session)
  await sleep(40)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].key, 'progressSummary')
  assert.ok(
    tui.calls.some(call => call.key === 'progress-summary' && call.text === '正在读取配置文件'),
    `expected the model line among ${JSON.stringify(tui.calls)}`,
  )
})

test('reasoning without a tool call never calls the model', async () => {
  let calls = 0
  const { ctx, handlers } = fakeCtx({
    llm: {
      async prepareCall(config) {
        calls += 1
        return { config, async *stream() { yield { type: 'text-delta', text: 'x' } } }
      },
    },
    sessionProjections: { register() {} },
    tuiStatus: { set() {} },
  })
  apply(ctx, { ...ready, quickLines: false })
  const session = { id: 'session-no-tool' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  })
  handlers['agent/assistant-stream']({
    agent: { session },
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '只有思考，没有工具调用。'.repeat(40) } },
  })
  await sleep(60)
  assert.equal(calls, 0)
})

test('the tool boundary also publishes the instant line', async () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: {
      async prepareCall(config) {
        return { config, async *stream() { yield { type: 'text-delta', text: '模型行' } } }
      },
    },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, ready)
  const session = { id: 'session-quick' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  })
  thinkThenCall(handlers, session, 'bash')
  await sleep(40)
  assert.ok(tui.calls.some(call => call.text === '正在读取文件 · config.ts' || call.text === '模型行'))
})

test('idle turn clears the TUI contribution', async () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: {
      async prepareCall(config) {
        return { config, async *stream() { yield { type: 'text-delta', text: '正在收尾' } } }
      },
    },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, ready)
  const session = { id: 'session-idle' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 2 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  })
  thinkThenCall(handlers, session)
  await sleep(40)
  handlers['session/event'](session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(tui.calls.at(-1).text, undefined)
})

test('a disabled switch stays wired but publishes nothing', async () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: { async prepareCall() { throw new Error('must not be called') } },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, { ...ready, enabled: false })
  const session = { id: 'session-off' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  })
  thinkThenCall(handlers, session)
  await sleep(40)
  // Clearing the TUI row (`undefined`) is allowed; a rendered line is not.
  assert.equal(tui.calls.filter(call => call.text !== undefined).length, 0)
})

test('a failing provider route does not throw and publishes no model line', async () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: {
      async prepareCall() {
        throw new Error('unknown provider')
      },
    },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, { ...ready, quickLines: false })
  const session = { id: 'session-broken' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'nope', model: 'nope' } } },
  })
  thinkThenCall(handlers, session)
  await sleep(60)
  assert.equal(tui.calls.length, 0)
})

test('auto route follows the session request header', async () => {
  const seen = []
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: {
      async prepareCall(config) {
        seen.push(`${config.provider}/${config.model}`)
        return { config, async *stream() { yield { type: 'text-delta', text: '正在跟着会话模型' } } }
      },
    },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, ready)
  const session = { id: 'session-auto' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-pro' } } },
  })
  thinkThenCall(handlers, session)
  await sleep(40)
  assert.equal(seen[0], 'deepseek-official/deepseek-pro')
  assert.equal(tui.calls.at(-1).text, '正在跟着会话模型')
})

test('a pinned model overrides the session route', async () => {
  const seen = []
  const { ctx, handlers } = fakeCtx({
    llm: {
      async prepareCall(config) {
        seen.push(`${config.provider}/${config.model}`)
        return { config, async *stream() { yield { type: 'text-delta', text: '固定模型' } } }
      },
    },
    sessionProjections: { register() {} },
    tuiStatus: { set() {} },
  })
  apply(ctx, { ...ready, provider: 'deepseek-official', model: 'deepseek-lite' })
  const session = { id: 'session-pinned' }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-pro' } } },
  })
  thinkThenCall(handlers, session)
  await sleep(40)
  assert.equal(seen[0], 'deepseek-official/deepseek-lite')
})

test('turn start publishes an intro line before any model output', () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: { async prepareCall() { throw new Error('unused') } },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, { lang: 'zh', quickLines: true })
  handlers['session/event']({ id: 's' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(tui.calls[0].text, '正在分析需求')
})

test('a tool call after a restart adopts the already-open turn', async () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: { async prepareCall() { throw new Error('not needed') } },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, { ...ready, quickLines: true, minTokens: 10_000 })
  const session = { id: 'session-adopt', header: { delegationDepth: 0 } }
  // No turn/start: the process started mid-turn.
  handlers['session/event'](session, {
    type: 'tool/call',
    data: { turn: 7, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' },
  })
  await sleep(20)
  assert.deepEqual(tui.calls.at(-1), { key: 'progress-summary', text: '正在运行命令 · ls' })
})

test('subagent sessions are skipped unless enabled', async () => {
  const tui = { calls: [], set(key, text) { this.calls.push({ key, text }) } }
  const { ctx, handlers } = fakeCtx({
    llm: { async prepareCall() { throw new Error('not needed') } },
    sessionProjections: { register() {} },
    tuiStatus: tui,
  })
  apply(ctx, { ...ready, quickLines: true })
  const session = { id: 'session-child', header: { delegationDepth: 1 } }
  handlers['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event'](session, {
    type: 'tool/call',
    data: { turn: 1, name: 'bash', arguments: '{"command":"ls"}' },
  })
  await sleep(20)
  assert.equal(tui.calls.length, 0)
})
