import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStylePrompt, STYLE_DEFAULTS } from '../src/style.js'

function config(values = {}) {
  const merged = { ...STYLE_DEFAULTS, ...values }
  return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, { get: () => value }]))
}

test('default style is short and actionable', () => {
  const prompt = buildStylePrompt(config())
  assert.match(prompt, /## 回复风格偏好/)
  assert.match(prompt, /保持回复简短/)
  assert.match(prompt, /便于行动/)
  assert.match(prompt, /复杂名词/)
  assert.doesNotMatch(prompt, /专业可靠/)
  assert.doesNotMatch(prompt, /跟随用户的写作风格/)
})

test('model verbosity still keeps actionable organization', () => {
  const prompt = buildStylePrompt(config({ verbosity: 'model' }))
  assert.match(prompt, /便于行动/)
  assert.doesNotMatch(prompt, /保持回复简短/)
})

test('disabling actionable and every style yields no section', () => {
  assert.equal(buildStylePrompt(config({ verbosity: 'model', actionable: false })), '')
})

test('each style compiles to one short line', () => {
  assert.match(buildStylePrompt(config({ style: 'professional' })), /专业可靠/)
  assert.match(buildStylePrompt(config({ style: 'friendly' })), /亲和友善/)
  assert.match(buildStylePrompt(config({ style: 'blunt' })), /直言不讳/)
  assert.match(buildStylePrompt(config({ style: 'follow' })), /模仿其句式长短/)
})

test('style and custom instructions append after length and actionable rules', () => {
  const prompt = buildStylePrompt(config({
    verbosity: 'high',
    style: 'follow',
    customInstructions: '先给结论；解释术语时用一句中文定义。',
  }))
  assert.match(prompt, /更详细/)
  assert.match(prompt, /模仿其句式长短/)
  assert.match(prompt, /先给结论；解释术语时用一句中文定义/)
})

test('custom instructions are capped and unknown style is ignored', () => {
  const prompt = buildStylePrompt(config({
    verbosity: 'model',
    actionable: false,
    style: 'unknown',
    customInstructions: 'x'.repeat(3000),
  }))
  assert.ok(prompt.includes('x'.repeat(2000)))
  assert.ok(!prompt.includes('x'.repeat(2001)))
  assert.doesNotMatch(prompt, /专业可靠|亲和友善|直言不讳/)
})

test('legacy baseStyle and writingStyle still resolve when style is absent', () => {
  assert.match(buildStylePrompt(config({ style: undefined, baseStyle: 'professional' })), /专业可靠/)
  assert.match(buildStylePrompt(config({ style: undefined, writingStyle: true })), /模仿其句式长短/)
  // An explicit style wins over the legacy fields.
  const prompt = buildStylePrompt(config({ style: 'blunt', baseStyle: 'professional', writingStyle: true }))
  assert.match(prompt, /直言不讳/)
  assert.doesNotMatch(prompt, /专业可靠|模仿其句式长短/)
})

test('missing config references fall back to defaults', () => {
  assert.match(buildStylePrompt({}), /保持回复简短/)
})
