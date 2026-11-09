import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStylePrompt, STYLE_DEFAULTS } from '../src/style.js'

function config(values = {}) {
  const merged = { ...STYLE_DEFAULTS, ...values }
  return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, { get: () => value }]))
}

test('default style keeps replies concise and adds nothing else', () => {
  const prompt = buildStylePrompt(config())
  assert.match(prompt, /## 回复风格偏好/)
  assert.match(prompt, /保持回复简洁/)
  assert.doesNotMatch(prompt, /基础风格/)
  assert.doesNotMatch(prompt, /亲切程度/)
  assert.doesNotMatch(prompt, /写作风格/)
})

test('model verbosity with default axes produces no section', () => {
  assert.equal(buildStylePrompt(config({ verbosity: 'model' })), '')
})

test('style presets and axes compile into short lines', () => {
  const prompt = buildStylePrompt(config({
    verbosity: 'high',
    baseStyle: 'professional',
    friendliness: 'reduced',
    enthusiasm: 'enhanced',
    emoji: 'reduced',
    visualAnswers: 'enhanced',
    headingsLists: 'reduced',
  }))
  assert.match(prompt, /更多细节/)
  assert.match(prompt, /专业可靠/)
  assert.match(prompt, /更专业、更事实性/)
  assert.match(prompt, /更有活力/)
  assert.match(prompt, /少用或不用表情符号/)
  assert.match(prompt, /表格、图示/)
  assert.match(prompt, /更多使用段落文本/)
})

test('writing style and custom instructions append after presets', () => {
  const prompt = buildStylePrompt(config({
    verbosity: 'medium',
    writingStyle: true,
    customInstructions: '先给结论；解释术语时用一句中文定义。',
  }))
  assert.match(prompt, /模仿其句式长短/)
  assert.match(prompt, /先给结论；解释术语时用一句中文定义/)
})

test('custom instructions are capped and unknown values are ignored', () => {
  const prompt = buildStylePrompt(config({
    verbosity: 'model',
    baseStyle: 'unknown',
    friendliness: 'unknown',
    customInstructions: 'x'.repeat(3000),
  }))
  assert.ok(prompt.includes('x'.repeat(2000)))
  assert.ok(!prompt.includes('x'.repeat(2001)))
  assert.doesNotMatch(prompt, /基础风格/)
  assert.doesNotMatch(prompt, /亲切程度/)
})

test('missing config references fall back to defaults', () => {
  const prompt = buildStylePrompt({})
  assert.match(prompt, /保持回复简洁/)
}) 
