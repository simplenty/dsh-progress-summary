import { test } from 'node:test'
import assert from 'node:assert/strict'

// The browser bundle registers itself on window; stub just enough to import it.
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

let bundle
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      bundle = factory(name => {
        if (name === 'react') return React
        throw new Error(`unexpected module: ${name}`)
      })
    },
  },
}

await import('../client.js')

const { compactSummary, displayUnits, fitSummary, parseLabel, composeRunningLine } = bundle.inline

test('compactSummary drops filler openers and keeps the first clause', () => {
  assert.equal(
    compactSummary('目标是把隧道服务端跑起来，现在先查看仓库里的安装脚本和服务端目录'),
    '把隧道服务端跑起来',
  )
  assert.equal(
    compactSummary('正在排查进度摘要功能为何没有显示，准备核对该功能模块是否已安装'),
    '排查进度摘要功能为何没有显示',
  )
})

test('compactSummary trims trailing punctuation and whitespace', () => {
  assert.equal(compactSummary('  修复启动项。 '), '修复启动项')
  assert.equal(compactSummary('修复启动项'), '修复启动项')
})

test('displayUnits counts CJK as one and Latin as roughly half', () => {
  assert.equal(displayUnits('中文'), 2)
  assert.ok(Math.abs(displayUnits('abcd') - 2.2) < 1e-9)
})

test('fitSummary never exceeds the unit budget', () => {
  const text = '重写属性注入相关代码块并补充文档注释'
  const fitted = fitSummary(text, 10)
  assert.ok(displayUnits(fitted) <= 10, fitted)
  assert.ok(fitted.endsWith('…'), fitted)
  assert.equal(fitSummary('短句', 10), '短句')
})

test('parseLabel splits the Chinese running label', () => {
  assert.deepEqual(parseLabel('深度求索中，用时 1 分 56 秒 ···'), {
    prefix: '深度求索中，',
    suffix: '，用时 1 分 56 秒 ···',
  })
  assert.deepEqual(parseLabel('深度求索中'), { prefix: '深度求索中，', suffix: '' })
  assert.equal(parseLabel(''), null)
})

test('parseLabel splits the English running label', () => {
  assert.deepEqual(parseLabel('Deep diving for 1m 56s ···'), {
    prefix: 'Deep diving, ',
    suffix: ', for 1m 56s ···',
  })
})

test('composeRunningLine merges the summary before the elapsed time', () => {
  const out = composeRunningLine({
    labelText: '深度求索中，用时 1 分 56 秒 ···',
    summary: '目标是把隧道服务端跑起来，现在先查看仓库里的安装脚本',
    maxUnits: 20,
  })
  assert.equal(out.text, '深度求索中，把隧道服务端跑起来，用时 1 分 56 秒 ···')
})

test('composeRunningLine hard-caps the summary at 20 units', () => {
  const long = '这是一个非常非常长的摘要'.repeat(3)
  const out = composeRunningLine({
    labelText: '深度求索中，用时 1 分 56 秒 ···',
    summary: long,
    maxUnits: 200,
  })
  assert.ok(displayUnits(out.summary) <= 20, out.summary)
  assert.ok(out.summary.endsWith('…'))
})

test('composeRunningLine keeps the width budget before the hard cap', () => {
  const out = composeRunningLine({
    labelText: '深度求索中，用时 1 分 56 秒 ···',
    summary: '重写属性注入相关代码块并补充文档注释',
    maxUnits: 8,
  })
  assert.ok(displayUnits(out.summary) <= 8, out.summary)
})

test('composeRunningLine drops the prefix on narrow rows', () => {
  const out = composeRunningLine({
    labelText: '深度求索中，用时 1 分 56 秒 ···',
    summary: '修复启动项',
    maxUnits: 20,
    narrow: true,
  })
  assert.equal(out.text, '修复启动项，用时 1 分 56 秒 ···')
})

test('composeRunningLine keeps ordering for English labels', () => {
  const out = composeRunningLine({
    labelText: 'Deep diving for 1m 56s ···',
    summary: 'fix the tunnel',
    maxUnits: 20,
  })
  assert.equal(out.text, 'Deep diving, fix the tunnel, for 1m 56s ···')
})

test('composeRunningLine returns null when there is nothing to show', () => {
  assert.equal(composeRunningLine({ labelText: '', summary: 'x', maxUnits: 20 }), null)
  assert.equal(composeRunningLine({ labelText: '深度求索中', summary: '   ', maxUnits: 20 }), null)
})
