/**
 * Pure rule engine for dsh-monitor: rule loading with mtime reload, fact
 * flattening, condition evaluation and firing selection.
 * No DSH imports — unit-testable with plain Node.
 */
import fs from 'node:fs'

let cache = { path: null, mtimeMs: -1, doc: null, error: null }

/** Load the rule document, re-reading it whenever the file changed. */
export function loadRules(rulesPath, stat = fs.statSync) {
  if (!rulesPath) return null
  let st
  try {
    st = stat(rulesPath)
  } catch {
    cache = { path: rulesPath, mtimeMs: -1, doc: null, error: 'rules file not found' }
    return null
  }
  if (cache.path === rulesPath && cache.mtimeMs === st.mtimeMs && cache.doc) return cache.doc
  try {
    const doc = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
    cache = { path: rulesPath, mtimeMs: st.mtimeMs, doc, error: null }
    return doc
  } catch (error) {
    cache = { path: rulesPath, mtimeMs: st.mtimeMs, doc: cache.doc, error: String(error?.message ?? error) }
    return cache.doc
  }
}

export function resetCache() {
  cache = { path: null, mtimeMs: -1, doc: null, error: null }
}

export function cacheInfo() {
  return { ...cache }
}

/** Merge collected session facts with workspace probe facts. */
export function flatten(facts, probe, now) {
  const out = { ...facts }
  out['progress.exists'] = probe.progress.exists
  out['progress.size'] = probe.progress.size
  out['progress.ageMin'] = probe.progress.exists ? Math.floor((now - probe.progress.mtime) / 60000) : 0
  out['raw.count'] = probe.raw.count
  out['raw.totalBytes'] = probe.raw.totalBytes
  out['raw.maxBytes'] = probe.raw.maxBytes
  out['elapsedMin'] = facts.firstUserAt ? Math.floor((now - facts.firstUserAt) / 60000) : 0
  out['sinceQQMin'] = facts.lastQQAt ? Math.floor((now - facts.lastQQAt) / 60000) : 0
  const startDate = facts.firstUserAt ? new Date(facts.firstUserAt) : new Date(now)
  out['date.crossedMidnight'] = startDate.toDateString() !== new Date(now).toDateString()
  // Verifier calls of any kind, summed for the "did you actually run it" check.
  const c = facts.cmd ?? {}
  out['cmd.checkAny'] =
    (c.check_xlsx ?? 0) + (c.check_all_tables ?? 0) + (c.check_cost_links ?? 0) +
    (c.check_t89 ?? 0) + (c.fmt_check ?? 0) + (c.verify_workbook ?? 0) + (c.closure_check ?? 0)
  const cn = facts.cmdNow ?? {}
  out['cmdNow.checkAny'] =
    (cn.check_xlsx ?? 0) + (cn.check_all_tables ?? 0) + (cn.check_cost_links ?? 0) +
    (cn.check_t89 ?? 0) + (cn.fmt_check ?? 0) + (cn.verify_workbook ?? 0) + (cn.closure_check ?? 0)
  // 进度文件是不是这一轮建的：别人会话上午写的进度文件不该替我消掉 A4
  out['progress.byMe'] = Boolean(
    probe.progress.exists && facts.firstUserAt && probe.progress.mtime >= facts.firstUserAt,
  )
  // 今日 raw 里有没有「这一轮」写的文件：别的会话上午落的盘，不能替我消掉 B1/B2
  out['raw.byMe'] = Boolean(
    facts.firstUserAt && (probe.raw?.todayFiles ?? []).some((f) => f.mtime >= facts.firstUserAt),
  )
  const memNames = probe.memory?.names ?? []
  const claimed = facts['claim.memoryNames'] ?? []
  out['claim.memoryUnbacked'] = claimed.filter((n) => !memNames.includes(n)).length
  return out
}

export function readFact(flat, key) {
  if (key in flat) return flat[key]
  if (key.startsWith('calls.byTool.')) {
    const tool = key.slice('calls.byTool.'.length)
    return flat['calls.byTool']?.[tool] ?? 0
  }
  if (key.startsWith('cmd.')) {
    const script = key.slice('cmd.'.length)
    return flat.cmd?.[script] ?? 0
  }
  if (key.startsWith('cmdNow.')) {
    const script = key.slice('cmdNow.'.length)
    return flat.cmdNow?.[script] ?? 0
  }
  return undefined
}

export function compare(actual, op, expected) {
  switch (op) {
    case '==': return actual === expected
    case '!=': return actual !== expected
    case '>=': return Number(actual) >= Number(expected)
    case '<=':
      return Number(actual) <= Number(expected)
    case '>': return Number(actual) > Number(expected)
    case '<': return Number(actual) < Number(expected)
    case 'contains': return String(actual ?? '').includes(String(expected))
    case 'matches': {
      try {
        return new RegExp(String(expected), 'i').test(String(actual ?? ''))
      } catch {
        return false
      }
    }
    case 'notMatches': {
      try {
        return !new RegExp(String(expected), 'i').test(String(actual ?? ''))
      } catch {
        return false
      }
    }
    default: return false
  }
}

/** Evaluate one condition node against the flattened facts. */
export function test(node, flat) {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node.all)) return node.all.every((n) => test(n, flat))
  if (Array.isArray(node.any)) return node.any.some((n) => test(n, flat))
  if (node.not !== undefined) return !test(node.not, flat)
  if (typeof node.fact === 'string') {
    if (node.fact === 'hasTool') return Boolean(flat.hasTool?.[String(node.value)])
    return compare(readFact(flat, node.fact), node.op ?? '==', node.value)
  }
  return false
}

/**
 * Pick at most one rule to report: lowest severity number first (0 = red line),
 * then by id. Respects per-rule cooldown and the per-session injection cap.
 */
export function decide(rulesDoc, flat, state, now, defaults = {}) {
  if (!rulesDoc || !Array.isArray(rulesDoc.rules)) return null
  const cooldown = defaults.cooldownMs ?? rulesDoc.defaults?.cooldownMs ?? 1200000
  // 0 / 缺省 / 非正数 = 不限次数（2026-11-18 用户定：取消次数限制）
  const rawMax = Number(defaults.maxInjections ?? rulesDoc.defaults?.maxInjections ?? 0)
  const maxInjections = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Infinity
  if (state.injections >= maxInjections) return null
  const hits = []
  for (const rule of rulesDoc.rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.when) continue
    if (rule.once && state.firedOnce?.has(rule.id)) continue
    const last = state.lastFired.get(rule.id) ?? 0
    if (now - last < cooldown) continue
    let fired = false
    try {
      fired = test(rule.when, flat)
    } catch {
      fired = false
    }
    if (fired) hits.push(rule)
  }
  if (!hits.length) return null
  hits.sort((a, b) => (a.sev ?? 3) - (b.sev ?? 3) || String(a.id).localeCompare(String(b.id)))
  const rule = hits[0]
  state.lastFired.set(rule.id, now)
  if (rule.once) {
    state.firedOnce = state.firedOnce ?? new Set()
    state.firedOnce.add(rule.id)
  }
  state.injections += 1
  return rule
}

/** One-line reminder text for a fired rule. */
export function render(rule, sevLabels = ['红线', '红线', '提醒', '提示']) {
  const label = sevLabels[rule.sev ?? 3] ?? '提示'
  return `【监工·${label}】${rule.say ?? rule.id}`
}
