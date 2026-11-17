import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  buildCorrectionMessage,
  buildDenyReason,
  mergeConfig,
  scanAssistantText,
  scanToolArguments,
  scanToolResult,
} from '../src/toolCallDetect.js'

// Fixture builders keep the samples readable; these are ordinary strings here.
const invoke = '<invoke name="write">'
const invokeEnd = '</invoke>'
const param = '<parameter name="content">'
const paramEnd = '</parameter>'
const toolCall = '<tool_call>'
const toolCallEnd = '</tool_call>'
const functionOpen = '<function=read>'
const functionEnd = '</function>'
const parameterShort = '<parameter=path>'
const parameterShortEnd = '</parameter>'

const NO_CALLS = { hasToolCalls: false, toolCallCount: 0 }

function codes(scan) {
  return scan.findings.map((finding) => finding.code)
}

test('mergeConfig keeps defaults and accepts only valid values', () => {
  const base = mergeConfig(undefined)
  assert.equal(base.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(base.maxLines, DEFAULT_CONFIG.maxLines)
  assert.equal(base.lang, 'zh')

  const merged = mergeConfig({ maxLines: 40, lang: 'en', endSequenceRepeats: 0, unknown: 1 })
  assert.equal(merged.maxLines, 40)
  assert.equal(merged.lang, 'en')
  // 0 is below the numeric minimum and must fall back to the default.
  assert.equal(merged.endSequenceRepeats, DEFAULT_CONFIG.endSequenceRepeats)
  assert.equal('unknown' in merged, false)
})

test('detects the strata <tool_call> leak that ends the turn silently', () => {
  const text = `已完成，用时1分18秒\n${toolCall} ${functionOpen} ${parameterShort} src/sync.js ${parameterShortEnd} ${functionEnd} ${toolCallEnd}`
  const scan = scanAssistantText(text, mergeConfig({}), NO_CALLS)
  assert.equal(scan.damaged, true)
  assert.equal(scan.silentFailure, true)
  assert.ok(codes(scan).includes('MARKUP_LEAKED_AS_TEXT'))
})

test('detects a JSON-bodied <tool_call> envelope', () => {
  const text = `好的，我来读文件。\n${toolCall}{"name":"read","arguments":{"path":"src/sync.js"}}${toolCallEnd}`
  const scan = scanAssistantText(text, mergeConfig({}), NO_CALLS)
  assert.equal(scan.damaged, true)
  assert.equal(scan.silentFailure, true)
})

test('a leaked canonical envelope with prose is damaged, without prose still flagged at head', () => {
  const prose = `已经写好了，下面是参数。\n${invoke}\n${param}<div class="banner">正文</div>${paramEnd}\n${invokeEnd}\n以上。`
  const proseScan = scanAssistantText(prose, mergeConfig({}), NO_CALLS)
  assert.equal(proseScan.damaged, true)
  assert.ok(codes(proseScan).includes('MARKUP_LEAKED_AS_TEXT'))

  const bare = `${invoke}${param}x${paramEnd}${invokeEnd}`
  const bareScan = scanAssistantText(bare, mergeConfig({}), NO_CALLS)
  assert.equal(bareScan.damaged, true)
})

test('healthy long content and ordinary HTML stay undamaged', () => {
  const cases = [
    '已经完成，用时 1 分 18 秒。下面我继续处理下一个文件。',
    '这里演示一下 HTML：<div class="a"><p>hi</p></div>，然后结束。',
    'const x = 1\n'.repeat(120),
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    `<html>\n${'<div class="x">内容</div>'}\n</html>`,
  ]
  for (const text of cases) {
    const scan = scanAssistantText(text, mergeConfig({}), NO_CALLS)
    assert.equal(scan.damaged, false, text.slice(0, 40))
    assert.equal(scan.silentFailure, false)
  }
})

test('damage with a real tool call in the same step is not a silent failure', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'text', text: `已完成，用时1分18秒\n${toolCall}${functionOpen}${parameterShort} src/sync.js ${parameterShortEnd}${functionEnd}${toolCallEnd}` },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: { path: 'src/sync.js' } },
    ],
  }
  let text = ''
  let toolCallCount = 0
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'tool-call') toolCallCount += 1
  }
  const scan = scanAssistantText(text, mergeConfig({}), { hasToolCalls: toolCallCount > 0, toolCallCount })
  assert.equal(scan.damaged, true)
  assert.equal(scan.silentFailure, false)
})

test('scanToolArguments denies only large structurally damaged leaves', () => {
  const long = `${invoke}${param}${'x'.repeat(2500)}${paramEnd}${invokeEnd}${invokeEnd}`
  const denied = scanToolArguments('write', { content: long }, mergeConfig({}))
  assert.equal(denied.action, 'deny')
  assert.ok(denied.reason.includes('未执行'))

  const short = `${invoke}${param}x${paramEnd}${invokeEnd}${invokeEnd}`
  const flagged = scanToolArguments('write', { content: short }, mergeConfig({}))
  assert.notEqual(flagged.action, 'deny')

  const healthy = scanToolArguments('write', { content: 'x'.repeat(500) }, mergeConfig({}))
  assert.equal(healthy.action, 'ok')
})

test('scanToolResult reports explicit no-op evidence for write-like tools only', () => {
  const config = mergeConfig({})
  const suspicious = scanToolResult('write_file', { path: 'a.txt', content: 'x'.repeat(40) }, { isError: false, value: { written: 0 } }, config)
  assert.equal(suspicious.suspicious, true)
  assert.ok(suspicious.reason.length > 0)

  const reader = scanToolResult('read', { path: 'a.txt' }, { isError: false, value: { written: 0 } }, config)
  assert.equal(reader.suspicious, false)

  const error = scanToolResult('write_file', { content: 'x'.repeat(40) }, { isError: true, value: { written: 0 } }, config)
  assert.equal(error.suspicious, false)
})

test('correction and deny text switch language', () => {
  const findings = [{ code: 'MARKUP_LEAKED_AS_TEXT', severity: 'error' }]
  assert.ok(buildCorrectionMessage(findings, mergeConfig({ lang: 'zh' })).length > 0)
  const en = buildCorrectionMessage(findings, mergeConfig({ lang: 'en' }))
  assert.match(en, /Structure check failed/)
  const zhDeny = buildDenyReason(findings, mergeConfig({ lang: 'zh' }))
  assert.match(zhDeny, /本次未执行/)
})
