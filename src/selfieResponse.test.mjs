import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('./selfieResponse.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { readSelfieJson } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

test('reads valid selfie API responses, including JSON errors', async () => {
  const result = await readSelfieJson(new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 }), 'Could not load photos')
  assert.deepEqual(result, { error: 'Session not found' })
})

test('reports incomplete responses with the action and HTTP status', async () => {
  for (const [body, status] of [['', 200], ['{"submissions":', 200], ['Bad Gateway', 502]]) {
    await assert.rejects(readSelfieJson(new Response(body, { status }), 'Could not load selfie submissions'),
      (error) => error.message.includes('Could not load selfie submissions') && error.message.includes(`HTTP ${status}`) && error.message.includes('invalid or incomplete response'))
  }
})

test('does not mask network errors while reading the response', async () => {
  const networkError = new TypeError('Connection interrupted')
  await assert.rejects(readSelfieJson({ json: async () => { throw networkError } }, 'Could not load photos'), (error) => error === networkError)
})
