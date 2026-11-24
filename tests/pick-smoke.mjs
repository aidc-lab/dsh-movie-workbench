/**
 * Offline integration test for `POST /pick` (AI picks the best BT row).
 *
 * Runs the real Host handler against a fake DSH LLM service so the streaming
 * path, prompt construction, JSON parsing and failure envelopes stay covered
 * without touching a model provider.
 *
 * Run via `make smoke` or `node tests/pick-smoke.mjs`.
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../lib/host.js'

const tests = []
const failures = []

function check(name, ok, detail) {
  tests.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

async function startServer(handler) {
  const server = http.createServer((req, res) => void handler(req, res))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

async function stopServer(server) {
  if (!server) return
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

async function postJson(origin, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const response = await fetch(`${origin}/movie-workbench/api/pick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  return { response, body: parsed }
}

function withCatalog(llm) {
  llm.listProviders = () => [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B' },
  ]
  llm.listModels = async provider => (
    provider === 'provider-a'
      ? [{ provider, id: 'model-a1', name: 'Model A1' }, { provider, id: 'model-a2', name: 'Model A2' }]
      : [{ provider, id: 'model-b1', name: 'Model B1' }]
  )
  return llm
}

function fakeLlm(answer, { failureCode = '' } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* () {
        if (failureCode) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: failureCode, message: 'provider exploded' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const rows = [
  { id: 'aaa111', title: 'Inception.2010.720p.BluRay', size: '1.2 GB', source: 'bitsearch', seeders: 12, leechers: 3 },
  { id: 'bbb222', title: 'Inception.2010.1080p.BluRay', size: '4.8 GB', source: 'bitsearch', seeders: 480, leechers: 60 },
  { id: 'ccc333', title: 'Inception.2010.2160p.REMUX', size: '61 GB', source: 'bt4g', seeders: null, leechers: null },
]
const item = { source: 'tmdb', id: '157336', title: 'Interstellar', kind: 'movie', year: 2014 }
const payload = { item, rows, lang: 'zh' }

const main = async () => {
  /* 1. selection + streamed JSON answer */
  const llm = withCatalog(fakeLlm('```json\n{"best": 2, "reason": "做种最多且体积合理", "picks": [{"rank": 1, "id": 2, "reason": "做种最多"}]}\n```'))
  const handler = createHandler({ requestTimeoutMs: 8000 }, {
    getLlm: () => llm,
    getSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  })
  const { server, origin } = await startServer(handler)
  try {
    const picked = await postJson(origin, payload)
    check('POST /pick -> 200 with a parsed pick', picked.response.status === 200 && picked.body?.ok === true && picked.body?.pick?.id === 'bbb222' && picked.body?.pick?.rank === 2, `HTTP ${picked.response.status}, pick=${JSON.stringify(picked.body?.pick)}`)
    check('envelope reports provider/model/tookMs', picked.body?.provider === 'deepseek' && picked.body?.model === 'deepseek-chat' && typeof picked.body?.tookMs === 'number', JSON.stringify({ provider: picked.body?.provider, model: picked.body?.model }))
    check('stream request carries the routed model and token budget', llm.calls.length === 1 && llm.calls[0].provider === 'deepseek' && llm.calls[0].model === 'deepseek-chat' && llm.calls[0].maxTokens === 3000, JSON.stringify({ provider: llm.calls[0]?.provider, model: llm.calls[0]?.model, maxTokens: llm.calls[0]?.maxTokens }))
    const system = String(llm.calls[0]?.system || '')
    const prompt = String(llm.calls[0]?.messages?.[0]?.content?.[0]?.text || '')
    check('prompt names the title and lists candidates with seeders', prompt.includes('Interstellar') && prompt.includes('480') && system.includes('JSON'), `prompt=${prompt.slice(0, 120)}…`)
    check(
      'the JSON output contract lives in the system prompt, not the editable prompt',
      system.includes('只输出一行 JSON') && system.includes('"best"') && !prompt.includes('只输出一行 JSON') && !prompt.includes('"picks"'),
      JSON.stringify({ system: system.slice(-90), prompt: prompt.slice(-90) }),
    )

    llm.calls.length = 0
    const prefPicked = await postJson(origin, { ...payload, preferences: { quality: 'best', language: 'ja', subtitle: 'bilingual' } })
    const prefPrompt = String(llm.calls[0]?.messages?.[0]?.content?.[0]?.text || '')
    check(
      'preferences are reflected in the user prompt and echoed',
      prefPicked.body?.ok === true &&
        prefPicked.body?.preferences?.quality === 'best' &&
        prefPicked.body?.preferences?.language === 'ja' &&
        prefPrompt.includes('最高画质') &&
        prefPrompt.includes('日语') &&
        prefPrompt.includes('中英双语'),
      JSON.stringify({ prefs: prefPicked.body?.preferences, prompt: prefPrompt.slice(0, 120) }),
    )

    const preview = await postJson(origin, { ...payload, preview: true, preferences: { quality: 'compact' } })
    check(
      'preview returns the default prompt without calling the model',
      preview.response.status === 200 &&
        preview.body?.ok === true &&
        preview.body?.preview === true &&
        typeof preview.body?.prompt === 'string' &&
        preview.body.prompt.includes('Interstellar') &&
        !preview.body.prompt.includes('只输出一行 JSON') &&
        String(preview.body?.system || '').includes('只输出一行 JSON') &&
        preview.body?.preferences?.quality === 'compact',
      `HTTP ${preview.response.status}, promptLen=${String(preview.body?.prompt || '').length}`,
    )

    llm.calls.length = 0
    const customPrompt = 'CUSTOM PROMPT: pick the smallest file and answer JSON.'
    const custom = await postJson(origin, { ...payload, prompt: customPrompt })
    check(
      'a custom prompt is sent verbatim and echoed back',
      llm.calls[0]?.messages?.[0]?.content?.[0]?.text === customPrompt &&
        custom.body?.prompt === customPrompt &&
        custom.body?.free === true,
      JSON.stringify({ sent: llm.calls[0]?.messages?.[0]?.content?.[0]?.text, echoed: custom.body?.prompt }),
    )

    const badPrefs = await postJson(origin, { ...payload, preferences: { quality: 'ultra' } })
    check(
      'POST /pick with an unknown preference value -> 400 bad_preferences',
      badPrefs.response.status === 400 && badPrefs.body?.code === 'bad_preferences',
      `HTTP ${badPrefs.response.status}, code=${badPrefs.body?.code}`,
    )

    const longPrompt = await postJson(origin, { ...payload, prompt: 'x'.repeat(4001) })
    check(
      'POST /pick with an oversized prompt -> 400 bad_prompt',
      longPrompt.response.status === 400 && longPrompt.body?.code === 'bad_prompt',
      `HTTP ${longPrompt.response.status}, code=${longPrompt.body?.code}`,
    )

    const models = await fetch(`${origin}/movie-workbench/api/models`)
    const modelsBody = await models.json()
    check(
      'GET /models -> providers, models and the profile selection',
      models.status === 200 &&
        modelsBody.ok === true &&
        modelsBody.providers.length === 2 &&
        modelsBody.models.length === 3 &&
        modelsBody.selection?.provider === 'deepseek' &&
        modelsBody.selection?.model === 'deepseek-chat',
      JSON.stringify({ providers: modelsBody.providers, selection: modelsBody.selection }),
    )

    llm.calls.length = 0
    const explicit = await postJson(origin, { ...payload, model: { provider: 'provider-b', model: 'model-b1' } })
    check(
      'POST /pick with an explicit advertised model uses it',
      explicit.body?.provider === 'provider-b' &&
        explicit.body?.model === 'model-b1' &&
        llm.calls[0]?.provider === 'provider-b' &&
        llm.calls[0]?.model === 'model-b1',
      JSON.stringify({ provider: explicit.body?.provider, call: llm.calls[0]?.model }),
    )

    const unknownModel = await postJson(origin, { ...payload, model: { provider: 'provider-a', model: 'nope' } })
    check(
      'POST /pick with an unknown model -> 400 bad_model',
      unknownModel.response.status === 400 && unknownModel.body?.code === 'bad_model',
      `HTTP ${unknownModel.response.status}, code=${unknownModel.body?.code}`,
    )

    const listModelsMissing = await fetch(`${origin}/movie-workbench/api/models`, { method: 'GET' })
    check('GET /models is a GET endpoint (200)', listModelsMissing.status === 200, `HTTP ${listModelsMissing.status}`)

    /* 2. fallback route from listModels() */
    const fallbackLlm = fakeLlm('{"best": 1}')
    fallbackLlm.listModels = async () => [{ provider: 'listed', id: 'listed-model' }]
    const fallbackHandler = createHandler({}, { getLlm: () => fallbackLlm, getSelection: () => null })
    const fallbackInstance = await startServer(fallbackHandler)
    try {
      const fallback = await postJson(fallbackInstance.origin, payload)
      check('missing selection falls back to the first advertised model', fallback.body?.provider === 'provider-a' && fallback.body?.model === 'model-a1' && fallback.body?.pick?.id === 'aaa111', JSON.stringify({ provider: fallback.body?.provider, model: fallback.body?.model, pick: fallback.body?.pick }))
    } finally {
      await stopServer(fallbackInstance.server)
    }

    /* 3. provider failure envelope */
    const failing = fakeLlm('', { failureCode: 'RATE_LIMIT' })
    const failingHandler = createHandler({}, { getLlm: () => failing, getSelection: () => ({ provider: 'p', model: 'm' }) })
    const failingInstance = await startServer(failingHandler)
    try {
      const failed = await postJson(failingInstance.origin, payload)
      check('provider failure keeps 200 and reports the adapter code', failed.response.status === 200 && failed.body?.ok === true && failed.body?.pick === null && failed.body?.errors?.[0]?.code === 'RATE_LIMIT', `HTTP ${failed.response.status}, code=${failed.body?.errors?.[0]?.code}`)
    } finally {
      await stopServer(failingInstance.server)
    }

    /* 4. unparseable answer */
    const garbage = fakeLlm('sorry, I cannot answer that')
    const garbageHandler = createHandler({}, { getLlm: () => garbage, getSelection: () => ({ provider: 'p', model: 'm' }) })
    const garbageInstance = await startServer(garbageHandler)
    try {
      const unparsed = await postJson(garbageInstance.origin, payload)
      check('unparseable answer falls back to a deterministic pick', unparsed.body?.pick?.id === 'bbb222' && unparsed.body?.pick?.rank === 2 && /自动推荐/.test(unparsed.body?.pick?.reason || '') && unparsed.body?.errors?.length === 0, JSON.stringify(unparsed.body?.pick))
    } finally {
      await stopServer(garbageInstance.server)
    }

    /* 5. oversized body */
    const huge = await postJson(origin, { ...payload, pad: 'x'.repeat(600 * 1024) })
    check('request body above 512 KiB -> 400 body_too_large', huge.response.status === 400 && huge.body?.code === 'body_too_large', `HTTP ${huge.response.status}, code=${huge.body?.code}`)
  } finally {
    await stopServer(server)
  }

  const passed = tests.length - failures.length
  console.log(`\nSUMMARY: ${passed}/${tests.length} required checks passed`)
  if (failures.length > 0) {
    console.log('FAILED:')
    for (const name of failures) console.log(`  - ${name}`)
  }
  console.log(failures.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch(error => {
  console.error('FATAL:', error)
  process.exitCode = 1
})
