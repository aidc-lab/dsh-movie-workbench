import { MODELS_CACHE_TTL_MS, MODEL_LOOKUP_TIMEOUT_MS, MODEL_MAX_PROVIDERS, PICK_LLM_SESSION_ID, PICK_LLM_TIMEOUT_MS, PICK_MAX_BODY_BYTES, PICK_MAX_ID_CHARS, PICK_MAX_PROMPT_CHARS, PICK_MAX_ROWS, PICK_MAX_TITLE_CHARS, PICK_MAX_TOKENS, PICK_PREFERENCE_DEFAULTS, PICK_PREFERENCE_KEYS, PICK_PREFERENCE_LABELS, PICK_PREFERENCE_OPTIONS } from './config.js'
import { sendJson } from './http.js'

/**
 * `POST /pick` — ask the profile's model to choose the best BT row for a
 * title. The browser sends the title metadata plus the rows it is showing;
 * the Host builds a compact prompt, streams one model call through the DSH
 * LLM service, and parses the model's JSON answer. The AI never touches
 * credentials: keys stay with the LLM adapters.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} settings
 * @param {{ getLlm?: () => any, getSelection?: () => any }} services
 */
export async function handlePick(req, res, settings, services) {
  const startedAt = Date.now()
  const body = await readPickBody(req)
  if (body.tooLarge) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'body_too_large',
      message: 'The request body must be at most 512 KiB.',
    })
    return
  }
  if (body.missing) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_body',
      message: 'The request body must be a JSON object.',
    })
    return
  }
  if (body.invalid) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_body',
      message: 'The request body must be valid JSON.',
    })
    return
  }
  const payload = body.value && typeof body.value === 'object' ? body.value : {}
  const item = payload.item && typeof payload.item === 'object' ? payload.item : {}
  const rawRows = Array.isArray(payload.rows) ? payload.rows : null
  if (!rawRows || rawRows.length === 0) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'empty_rows',
      message: 'The "rows" array must contain at least one candidate.',
    })
    return
  }
  if (rawRows.length > PICK_MAX_ROWS) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'too_many_rows',
      message: `The "rows" array must contain at most ${PICK_MAX_ROWS} candidates.`,
    })
    return
  }
  const rows = rawRows.map(normalizePickRow).filter(Boolean)
  if (rows.length === 0) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'invalid_rows',
      message: 'Every row needs a non-empty "id" and "title".',
    })
    return
  }
  const lang = typeof payload.lang === 'string' && payload.lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
  const preferences = normalizePickPreferences(payload.preferences)
  if (preferences === null) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_preferences',
      message: `The "preferences" field must contain valid ${PICK_PREFERENCE_KEYS.join(', ')} values.`,
    })
    return
  }
  const customPrompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_prompt',
      message: 'The "prompt" field must be a string.',
    })
    return
  }
  if (customPrompt.length > PICK_MAX_PROMPT_CHARS) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_prompt',
      message: `The "prompt" field must be at most ${PICK_MAX_PROMPT_CHARS} characters.`,
    })
    return
  }
  const previewOnly = payload.preview === true
  const built = buildPickPrompt({ item, rows, lang, preferences })
  const effectivePrompt = customPrompt || built.prompt
  if (previewOnly) {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      preview: true,
      prompt: effectivePrompt,
      system: built.system,
      preferences,
      tookMs: Date.now() - startedAt,
      errors: [],
    })
    return
  }
  const requestedModel = normalizePickModel(payload.model)
  if (payload.model !== undefined && payload.model !== null && !requestedModel) {
    sendJson(req, res, 400, {
      ok: false,
      code: 'bad_model',
      message: 'The "model" field must be { provider, model } with non-empty strings.',
    })
    return
  }

  const llm = services && typeof services.getLlm === 'function' ? services.getLlm() : null
  if (!llm || typeof llm.stream !== 'function') {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      provider: null,
      model: null,
      tookMs: Date.now() - startedAt,
      pick: null,
      picks: [],
      analysis: '',
      prompt: effectivePrompt,
      preferences,
      free: Boolean(customPrompt),
      errors: [pickFailure('llm_unavailable', 'The AI model service is not available in this DSH profile.')],
    })
    return
  }

  let route = resolvePickRoute(services)
  if (requestedModel) {
    const catalog = await collectLlmCatalog(llm, services)
    const known = catalog.models.some(
      (entry) => entry.provider === requestedModel.provider && entry.id === requestedModel.model,
    )
    if (!known) {
      sendJson(req, res, 400, {
        ok: false,
        code: 'bad_model',
        message: 'The requested model is not advertised by this DSH profile.',
      })
      return
    }
    route = { provider: requestedModel.provider, model: requestedModel.model }
  }
  if (!route.provider || !route.model) {
    const catalog = await collectLlmCatalog(llm, services)
    const first = catalog.models[0]
    if (first) route = { provider: first.provider, model: first.id }
  }
  if (!route.provider || !route.model) {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      provider: null,
      model: null,
      tookMs: Date.now() - startedAt,
      pick: null,
      picks: [],
      analysis: '',
      prompt: effectivePrompt,
      preferences,
      free: Boolean(customPrompt),
      errors: [pickFailure('llm_no_model', 'No model is configured for this DSH profile.')],
    })
    return
  }

  const system = built.system
  const prompt = effectivePrompt
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, PICK_LLM_TIMEOUT_MS)
  let text = ''
  let failure = null
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: PICK_MAX_TOKENS,
      temperature: 0.2,
      signal: controller.signal,
      // Session-scoped providers (e.g. opencode-go) need a routing id on the
      // request; this auxiliary call is not part of a chat session, so use a
      // stable bucket shared by every pick request.
      sessionId: PICK_LLM_SESSION_ID,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        failure = chunk.reason.failure || { code: 'llm_error', message: 'The AI request failed.' }
      }
    }
  } catch (error) {
    failure = error || { code: 'llm_error', message: 'The AI request failed.' }
  } finally {
    clearTimeout(timer)
  }

  const tookMs = Date.now() - startedAt
  if (failure) {
    const code = timedOut ? 'llm_timeout' : (failure && typeof failure.code === 'string' ? failure.code : 'llm_error')
    const message = timedOut
      ? 'The AI request timed out.'
      : String((failure && failure.message) || 'The AI request failed.').slice(0, 300)
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      provider: route.provider,
      model: route.model,
      tookMs,
      pick: null,
      picks: [],
      analysis: '',
      prompt,
      preferences,
      free: Boolean(customPrompt),
      errors: [pickFailure(code, message)],
    })
    return
  }

  let parsed = parsePickResponse(text, rows)
  let pickErrors = []
  if (!parsed.pick) {
    const fallback = fallbackPick(rows, lang)
    if (fallback) {
      parsed = {
        pick: fallback,
        picks: parsed.picks,
        analysis: parsed.analysis,
        parseFailed: false,
      }
    } else {
      pickErrors = [pickFailure('llm_unparseable', 'The model response did not contain parseable JSON.')]
    }
  }
  sendJson(req, res, 200, {
    ok: true,
    source: 'llm',
    provider: route.provider,
    model: route.model,
    tookMs,
    pick: parsed.pick,
    picks: parsed.picks,
    analysis: parsed.analysis,
    prompt,
    preferences,
    free: Boolean(customPrompt),
    errors: pickErrors,
  })
}
/**
 * Read and JSON-parse the `POST /pick` body with a hard size cap.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ value?: any, missing?: true, invalid?: true, tooLarge?: true }>}
 */
export async function readPickBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > PICK_MAX_BODY_BYTES) return { tooLarge: true }
    chunks.push(chunk)
  }
  if (total === 0) return { missing: true }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { invalid: true }
  }
}
/**
 * Shape one candidate row sent by the browser; unknown extras are dropped so
 * the prompt cannot be inflated with arbitrary client state.
 *
 * @param {unknown} value
 * @returns {{ id: string, title: string, size: string, source: string, seeders: number | null, leechers: number | null } | null}
 */
export function normalizePickRow(value) {
  if (!value || typeof value !== 'object') return null
  const id = pickText(value.id)
  const title = pickText(value.title)
  if (!id || !title) return null
  return {
    id: id.slice(0, PICK_MAX_ID_CHARS),
    title: title.slice(0, PICK_MAX_TITLE_CHARS),
    size: pickText(value.size).slice(0, 40),
    source: pickText(value.source).slice(0, 20),
    seeders: pickCount(value.seeders),
    leechers: pickCount(value.leechers),
  }
}
/**
 * Trim a scalar into a string (numbers allowed, objects ignored).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function pickText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}
/**
 * Coerce a swarm count to a non-negative integer or null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function pickCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.trunc(number)
}
/**
 * Build one normalized error entry for the pick envelope.
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ source: 'llm', code: string, message: string }}
 */
export function pickFailure(code, message) {
  return { source: 'llm', code, message }
}

/** Last successful `/models` catalog, reused for one minute. */
let modelsCatalogCache = null

/**
 * Race one catalog promise against a timeout without leaving it unbounded.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('catalog timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
/**
 * Enumerate every registered provider and the models it advertises.
 *
 * @param {any} llm
 * @param {{ getSelection?: () => any }} services
 * @returns {Promise<{ selection: { provider: string, model: string } | null, providers: { id: string, name: string }[], models: { provider: string, id: string, name: string, description?: string }[], errors: object[] }>}
 */
export async function collectLlmCatalog(llm, services) {
  const now = Date.now()
  if (modelsCatalogCache && now - modelsCatalogCache.at < MODELS_CACHE_TTL_MS) {
    return modelsCatalogCache.value
  }
  const errors = []
  const providers = []
  try {
    const list = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    if (Array.isArray(list)) {
      for (const entry of list.slice(0, MODEL_MAX_PROVIDERS)) {
        if (entry && typeof entry.id === 'string' && entry.id) {
          providers.push({ id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id })
        }
      }
    }
  } catch {
    errors.push(pickFailure('catalog_error', 'Could not list the LLM providers.'))
  }
  const models = []
  await Promise.all(
    providers.map(async (provider) => {
      if (typeof llm.listModels !== 'function') return
      try {
        const list = await withTimeout(llm.listModels(provider.id), MODEL_LOOKUP_TIMEOUT_MS)
        if (!Array.isArray(list)) return
        for (const entry of list) {
          if (!entry || typeof entry.id !== 'string' || !entry.id) continue
          models.push({
            provider: provider.id,
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
            ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}),
          })
        }
      } catch {
        errors.push(pickFailure('catalog_error', `Could not list models for "${provider.id}".`))
      }
    }),
  )
  const selection = resolvePickRoute(services)
  const value = {
    selection: selection.provider && selection.model ? { provider: selection.provider, model: selection.model } : null,
    providers,
    models,
    errors,
  }
  modelsCatalogCache = { at: now, value }
  return value
}
/**
 * `GET /models` — the advertised provider/model catalog plus the profile default.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ getLlm?: () => any, getSelection?: () => any }} services
 */
export async function handleModels(req, res, services) {
  const llm = services && typeof services.getLlm === 'function' ? services.getLlm() : null
  if (!llm || typeof llm.listProviders !== 'function') {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      selection: null,
      providers: [],
      models: [],
      errors: [pickFailure('llm_unavailable', 'The AI model service is not available in this DSH profile.')],
    })
    return
  }
  try {
    const catalog = await collectLlmCatalog(llm, services)
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      selection: catalog.selection,
      providers: catalog.providers,
      models: catalog.models,
      errors: catalog.errors,
    })
  } catch {
    sendJson(req, res, 200, {
      ok: true,
      source: 'llm',
      selection: null,
      providers: [],
      models: [],
      errors: [pickFailure('catalog_error', 'Could not read the model catalog.')],
    })
  }
}
/**
 * Normalize the optional `model` field of a pick request.
 *
 * @param {unknown} value
 * @returns {{ provider: string, model: string } | null}
 */
/**
 * Normalize the viewer preference object posted with a /pick request.
 * Missing keys fall back to the defaults; malformed values return null.
 *
 * @param {unknown} value
 * @returns {{ quality: string, language: string, subtitle: string } | null}
 */
export function normalizePickPreferences(value) {
  if (value === undefined || value === null) return { ...PICK_PREFERENCE_DEFAULTS }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const prefs = { ...PICK_PREFERENCE_DEFAULTS }
  for (const key of PICK_PREFERENCE_KEYS) {
    const candidate = value[key]
    if (candidate === undefined || candidate === null) continue
    if (typeof candidate !== 'string' || !PICK_PREFERENCE_OPTIONS[key].includes(candidate)) return null
    prefs[key] = candidate
  }
  return prefs
}
export function normalizePickModel(value) {
  if (!value || typeof value !== 'object') return null
  const provider = pickText(value.provider).trim()
  const model = pickText(value.model).trim()
  if (!provider || !model || provider.length > 64 || model.length > 200) return null
  return { provider, model }
}
/**
 * Resolve the profile's default provider/model selection.
 *
 * @param {{ getSelection?: () => any }} services
 * @returns {{ provider: string, model: string }}
 */
export function resolvePickRoute(services) {
  const route = { provider: '', model: '' }
  try {
    const selection = services && typeof services.getSelection === 'function' ? services.getSelection() : null
    if (selection && typeof selection.provider === 'string' && selection.provider && typeof selection.model === 'string' && selection.model) {
      route.provider = selection.provider
      route.model = selection.model
    }
  } catch {
    // Treat a broken selection source as "no selection".
  }
  return route
}
/**
 * Build the system + user prompt for one pick call.
 *
 * @param {{ item: object, rows: object[], lang: 'zh' | 'en' }} options
 * @returns {{ system: string, prompt: string }}
 */
export function buildPickPrompt({ item, rows, lang, preferences }) {
  const zh = lang !== 'en'
  const title = pickText(item.title) || (zh ? '未命名作品' : 'Untitled')
  const year = pickText(item.year)
  const kind = item.kind === 'tv' ? (zh ? '剧集' : 'TV series') : (zh ? '电影' : 'movie')
  const lines = rows.map((row, index) => {
    const parts = [`${index + 1}. ${row.title}`]
    if (row.size) parts.push(zh ? `大小 ${row.size}` : `size ${row.size}`)
    if (row.seeders !== null) parts.push(zh ? `做种 ${row.seeders}` : `seeders ${row.seeders}`)
    if (row.leechers !== null) parts.push(zh ? `下载 ${row.leechers}` : `leechers ${row.leechers}`)
    if (row.source) parts.push(zh ? `来源 ${row.source}` : `source ${row.source}`)
    return parts.join(' · ')
  })
  const labels = PICK_PREFERENCE_LABELS[zh ? 'zh' : 'en']
  const prefs = preferences || PICK_PREFERENCE_DEFAULTS
  const priorityLines = [
    `${labels.quality.title}: ${labels.quality[prefs.quality] || prefs.quality}`,
    `${labels.language.title}: ${labels.language[prefs.language] || prefs.language}`,
    `${labels.subtitle.title}: ${labels.subtitle[prefs.subtitle] || prefs.subtitle}`,
  ].join('\n')
  const systemBase = zh
    ? '你是影视资源挑选助手。请比较候选 BT 资源，挑出最值得下载的一个：综合做种数、资源大小是否合理、画质/片源/编码/字幕线索与来源可靠性，做种过少或来源不明的要降权。只输出 JSON，不要 Markdown，不要额外解释。'
    : 'You pick the best torrent for a title. Compare seeder counts, size sanity, quality/source/codec/subtitle hints and index reliability; down-rank dead or sketchy entries. Output JSON only, no Markdown and no extra prose.'
  const instruction = zh
    ? '只输出一行 JSON（不要代码块、不要换行）：{"best": 编号, "reason": "不超过 40 字的中文理由", "picks": [{"rank": 1, "id": 编号, "reason": "理由"}]}'
    : 'Output exactly one line of JSON (no code fence, no newlines): {"best": index, "reason": "one-sentence reason", "picks": [{"rank": 1, "id": index, "reason": "reason"}]}'
  const system = `${systemBase}\n\n输出格式（不可修改）：${instruction}`
  const priority = `${labels.priority}\n${priorityLines}\n\n`
  const head = zh
    ? `作品：${title}${year ? `（${year}）` : ''}，${kind}。\n${priority}候选 BT 资源（编号从 1 开始）：\n${lines.join('\n')}\n\n`
    : `Title: ${title}${year ? ` (${year})` : ''}, ${kind}.\n${priority}Candidate torrents (1-based):\n${lines.join('\n')}\n\n`
  return { system, prompt: head }
}
/**
 * Parse a model answer into a pick. Accepts plain JSON, fenced JSON or JSON
 * embedded in an explanation. Returns `parseFailed` when no object parses.
 *
 * @param {string} text
 * @param {object[]} rows
 * @returns {{ pick: { id: string, rank: number, reason: string } | null, picks: { id: string, reason: string }[], analysis: string, parseFailed: boolean }}
 */
/**
 * Deterministic fallback used when the model returns nothing usable: rank by
 * seeders first, then by a plausible size and a higher-resolution hint.
 *
 * @param {object[]} rows
 * @param {string} lang
 * @returns {{ id: string, rank: number, reason: string } | null}
 */
export function fallbackPick(rows, lang) {
  const zh = lang !== 'en'
  let best = null
  let bestScore = -Infinity
  rows.forEach((row, index) => {
    const seeders = typeof row.seeders === 'number' ? row.seeders : 0
    const size = String(row.size || '')
    const gb = Number((size.match(/([\d.]+)\s*GB/i) || size.match(/([\d.]+)\s*GiB/i) || [])[1])
    const sizeScore = Number.isFinite(gb) && gb >= 0.3 && gb <= 40 ? 6 : 0
    const resolution = /2160p|4k/i.test(row.title) ? 24 : /1080p/i.test(row.title) ? 18 : /720p/i.test(row.title) ? 8 : 0
    const score = Math.min(seeders, 400) + sizeScore + resolution
    if (score > bestScore) {
      bestScore = score
      best = { id: String(row.id), rank: index + 1, reason: zh
        ? '模型未返回有效结果，已按做种数、分辨率与体积自动推荐。'
        : 'The model returned nothing usable; picked by seeders, resolution and size.' }
    }
  })
  return best
}
export function parsePickResponse(text, rows) {
  const limit = Array.isArray(rows) ? rows.length : 0
  const raw = typeof text === 'string' ? text : ''
  const cleaned = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, '').trim()
  const candidates = []
  if (cleaned) candidates.push(cleaned)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1))
  let parsed = null
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate)
      break
    } catch {
      // Try the next candidate.
    }
  }
  const result = { pick: null, picks: [], analysis: cleaned.slice(0, 2000), parseFailed: parsed === null }
  if (!parsed || typeof parsed !== 'object') {
    // Tolerate truncated or loosely formatted answers: recover the numbered
    // best index and reason with a small regex instead of failing outright.
    const bestMatch = cleaned.match(/["']?best["']?\s*[:=]\s*["']?(\d{1,3})/i)
    if (bestMatch) {
      const reasonMatch = cleaned.match(/["']?reason["']?\s*[:=]\s*["']([^"']{1,240})/i)
      parsed = { best: Number(bestMatch[1]), reason: reasonMatch ? reasonMatch[1] : '' }
    } else {
      return result
    }
  }
  const toIndex = (value) => {
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
    return null
  }
  const reasonOf = (value) => (typeof value === 'string' ? value.trim().slice(0, 240) : '')
  const picks = []
  if (Array.isArray(parsed.picks)) {
    for (const entry of parsed.picks) {
      if (!entry || typeof entry !== 'object') continue
      const index = toIndex(entry.id !== undefined ? entry.id : entry.index)
      if (index === null || index < 1 || index > limit) continue
      const row = rows[index - 1]
      if (!row) continue
      picks.push({ id: String(row.id), rank: index, reason: reasonOf(entry.reason) })
    }
    picks.sort((left, right) => left.rank - right.rank)
  }
  let best = toIndex(parsed.best)
  if (best === null) best = toIndex(parsed.pick)
  if (best === null && picks.length > 0) best = picks[0].rank
  if (best !== null && best >= 1 && best <= limit && rows[best - 1]) {
    const directReason = reasonOf(parsed.reason)
    const ranked = picks.find((entry) => entry.rank === best)
    result.pick = {
      id: String(rows[best - 1].id),
      rank: best,
      reason: directReason || (ranked ? ranked.reason : ''),
    }
  }
  result.picks = picks.map((entry) => ({ id: entry.id, reason: entry.reason }))
  result.parseFailed = parsed === null
  return result
}
