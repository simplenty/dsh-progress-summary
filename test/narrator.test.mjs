import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Narrator, cleanLine, quickToolLine, tailText, toolLabel, userPrompt } from '../narrator.js'
import { createProgressProjection, PROGRESS_RECORD_TYPE } from '../projection.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Minimal narrator config for the tests: no time floor, 1 char ≈ 1 token. */
function config(overrides = {}) {
  return {
    minIntervalMs: 0,
    minTokens: 10,
    charsPerToken: 1,
    excerptChars: 200,
    maxLineChars: 20,
    maxPerTurn: 10,
    lang: 'zh',
    quickLines: false,
    ...overrides,
  }
}

test('cleanLine strips wrappers and trailing punctuation', () => {
  assert.equal(cleanLine('“正在读取配置文件。”', 20), '正在读取配置文件')
  assert.equal(cleanLine('- 进度：正在运行测试；', 20), '正在运行测试')
  assert.equal(cleanLine('**正在**  修改代码', 20), '正在 修改代码')
  assert.equal(cleanLine('第一行\n第二行', 20), '第一行')
  assert.equal(cleanLine('', 20), '')
})

test('cleanLine caps the line', () => {
  assert.equal(cleanLine('一二三四五六七八九十', 5), '一二三四五')
})

test('tailText keeps the end and collapses whitespace', () => {
  assert.equal(tailText('a\n\n  b   c', 100), 'a b c')
  assert.equal(tailText('0123456789', 4), '6789')
})

test('toolLabel prefers the concrete command, then other arguments', () => {
  assert.equal(
    toolLabel('bash', '{"command":"npm test","description":"运行测试"}', 40),
    'bash npm test',
  )
  assert.equal(toolLabel('custom', '{"description":"整理文件"}', 40), 'custom 整理文件')
  assert.equal(toolLabel('bash', 'not json', 40), 'bash not json')
  assert.equal(toolLabel('', '{}', 40), '')
})

test('quickToolLine maps common tools to a readable line', () => {
  assert.equal(quickToolLine('bash', '{"command":"npm test"}', 'zh', 28), '正在运行命令 · npm test')
  assert.equal(quickToolLine('read', '{"file_path":"/tmp/a.ts"}', 'zh', 28), '正在读取文件 · /tmp/a.ts')
  assert.equal(quickToolLine('bash', '{"command":"npm test"}', 'en', 28), 'running · npm test')
  assert.equal(quickToolLine('', '{}', 'zh', 28), '')
})

test('userPrompt carries only the previous line and the reasoning', () => {
  const prompt = userPrompt({ lastLine: '', excerpt: 'abc', lang: 'zh' })
  assert.match(prompt, /上一条：（无）/u)
  assert.match(prompt, /最近思考：abc/u)
  assert.doesNotMatch(prompt, /当前动作/u)
})

test('a tool boundary summarizes the complete reasoning before it', async () => {
  const published = []
  const calls = []
  const narrator = new Narrator(config(), {
    callModel: async input => {
      calls.push(input)
      return '「正在读取配置并确认端口」'
    },
    publish: value => published.push(value),
  })
  narrator.beginTurn(1)
  narrator.noteText('我需要先看看配置文件里写了什么，然后再决定改哪里。')
  assert.equal(calls.length, 0, 'streaming alone never triggers a call')
  narrator.noteTool('read', '{"file_path":"config.ts"}')
  await sleep(20)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].system.includes('进度播报员'), true)
  assert.equal(published.at(-1).line, '正在读取配置并确认端口')
  assert.equal(published.at(-1).state, 'running')
  narrator.dispose()
})

test('no tool call means no model summary', async () => {
  let calls = 0
  const narrator = new Narrator(config(), {
    callModel: async () => {
      calls += 1
      return '不该出现'
    },
    publish: () => {},
  })
  narrator.beginTurn(1)
  narrator.noteText('很长的思考内容，但没有调用任何工具，所以不该总结。'.repeat(10))
  await sleep(40)
  assert.equal(calls, 0)
  narrator.dispose()
})

test('the token floor holds material for the next tool boundary', async () => {
  const calls = []
  const narrator = new Narrator(config({ minTokens: 100 }), {
    callModel: async () => {
      calls.push(Date.now())
      return '模型行'
    },
    publish: () => {},
  })
  narrator.beginTurn(1)
  narrator.noteText('短')
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(10)
  assert.equal(calls.length, 0, 'below the token floor')
  narrator.noteText('补足到阈值以上的思考内容。'.repeat(12))
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(10)
  assert.equal(calls.length, 1)
  narrator.dispose()
})

test('the time floor holds material until it elapses', async () => {
  const calls = []
  const narrator = new Narrator(config({ minIntervalMs: 80 }), {
    callModel: async () => {
      calls.push(Date.now())
      return `行${calls.length}`
    },
    publish: () => {},
  })
  narrator.beginTurn(1)
  narrator.noteText('第一段足够长的思考内容，触发第一次播报。')
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(calls.length, 1)
  narrator.noteText('第二段足够长的思考内容，但时间没到。')
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(calls.length, 1, 'blocked by the time floor')
  await sleep(80)
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(calls.length, 2, 'the retained material fires at the next boundary')
  narrator.dispose()
})

test('narrator never exceeds the per-turn budget', async () => {
  let calls = 0
  const narrator = new Narrator(config({ maxPerTurn: 2 }), {
    callModel: async () => {
      calls += 1
      return `第${calls}次`
    },
    publish: () => {},
  })
  narrator.beginTurn(1)
  for (let index = 0; index < 6; index += 1) {
    narrator.noteText('足够的思考内容'.repeat(3))
    narrator.noteTool('bash', '{"command":"ls"}')
    await sleep(10)
  }
  assert.equal(calls, 2)
  narrator.dispose()
})

test('endTurn aborts pending work and publishes idle', async () => {
  const published = []
  const narrator = new Narrator(config({ minTokens: 1_000 }), {
    callModel: async () => '正在思考',
    publish: value => published.push(value),
  })
  narrator.beginTurn(1)
  narrator.noteText('一段思考内容。')
  narrator.endTurn()
  assert.equal(published.at(-1).state, 'idle')
  assert.equal(published.at(-1).line, '')
  await sleep(20)
  assert.equal(published.length, 1)
})

test('a failed auxiliary call keeps the material for the next boundary', async () => {
  let fail = true
  const published = []
  const narrator = new Narrator(config(), {
    callModel: async () => {
      if (fail) throw new Error('provider down')
      return '重试成功'
    },
    publish: value => published.push(value),
  })
  narrator.beginTurn(1)
  narrator.noteText('一段足够长的思考内容，第一次播报失败。')
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(published.length, 0)
  fail = false
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(published.at(-1).line, '重试成功')
  narrator.dispose()
})

test('a tool boundary publishes an instant line without calling the model', async () => {
  const published = []
  let calls = 0
  const narrator = new Narrator(config({ quickLines: true, minTokens: 1_000 }), {
    callModel: async () => {
      calls += 1
      return '模型行'
    },
    publish: value => published.push(value),
  })
  narrator.beginTurn(1)
  narrator.noteTool('bash', '{"command":"npm test"}')
  assert.equal(published.length, 1)
  assert.equal(published[0].line, '正在运行命令 · npm test')
  assert.equal(calls, 0)
  narrator.dispose()
})

test('projection folds only the narrator record', () => {
  const projection = createProgressProjection({ now: () => 5 })
  const init = projection.init()
  assert.equal(projection.apply(init, { type: 'tool/call', data: {} }), init)
  const next = projection.apply(init, {
    type: PROGRESS_RECORD_TYPE,
    data: { line: '正在跑测试', state: 'running', turn: 3, at: 42, calls: 2 },
  })
  assert.deepEqual(next, { line: '正在跑测试', state: 'running', turn: 3, at: 42, calls: 2 })
  assert.equal(projection.wire.view(next), next)
})

test('projection marks an unknown state as idle', () => {
  const projection = createProgressProjection()
  const next = projection.apply(projection.init(), {
    type: PROGRESS_RECORD_TYPE,
    data: { line: 'x', state: 'weird' },
  })
  assert.equal(next.state, 'idle')
})

test('quick lines never consume the model time floor', async () => {
  let calls = 0
  const narrator = new Narrator(config({ quickLines: true, minIntervalMs: 30_000 }), {
    callModel: async () => {
      calls += 1
      return '模型行'
    },
    publish: () => {},
  })
  narrator.beginTurn(1)
  narrator.noteText('足够的思考内容。'.repeat(4))
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(calls, 1)
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(calls, 1, 'the second boundary is blocked by the model floor')
  narrator.dispose()
})

test('a tool boundary without reasoning produces no summary', async () => {
  let calls = 0
  const narrator = new Narrator(config(), {
    callModel: async () => {
      calls += 1
      return '不该出现'
    },
    publish: () => {},
  })
  narrator.beginTurn(1)
  narrator.noteTool('bash', '{"command":"ls"}')
  await sleep(20)
  assert.equal(calls, 0)
  narrator.dispose()
})
