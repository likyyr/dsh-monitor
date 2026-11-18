/**
 * dsh-monitor — L1 rule supervisor for DeepSeek Harness.
 *
 * Each agent step, evaluate a declarative rule list (JSON, hot-reloaded by mtime)
 * against facts derived from the session log, and when a rule fires, append one
 * source-attributed user message to the step. The message carries
 * `source.kind = 'monitor'`, so the UI renders it as a collapsed
 * "上下文注入 · monitor" block instead of a user turn.
 *
 * Rules live outside the package (config.rulesPath) and are re-read on change:
 * editing the list never requires reinstalling or restarting DSH.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { probeWorkspace, probeRecentWrites } from './probe.js'
import { loadRules, flatten, decide, render } from './rules.js'

/** Cordis plugin name used by loader diagnostics and the injection source tag. */
export const name = 'dsh-monitor'

/** Services this plugin reads. */
export const inject = ['agents']

/* --------------------------------------------------------------- fact model */

function textsOf(message) {
  const out = []
  const content = message?.content
  if (!Array.isArray(content)) return out
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out
}

/** Walk the session log backwards and fold the facts the rules can read. */
export function collect(agent, limit = 1200) {
  const facts = {
    'calls.total': 0,
    'calls.sinceWrite': 0,
    'replies.count': 0,
    'calls.sinceProgress': 0,
    'calls.byTool': Object.create(null),
    'text.userAll': '',
    'text.commands': '',
    'text.commandsWrite': '',
    'text.writePaths': '',
    'text.assistant': '',
    firstUserAt: null,
    lastQQAt: null,
    lastProgressWriteAt: null,
    hasTool: Object.create(null),
  }
  const userParts = []
  const cmdParts = []
  /** Script names counted from command text — most work runs through pwsh, not a dedicated tool. */
  const SCRIPT_KEYS = [
    'qq_notify', 'workbrief', 'plugin_preflight', 'verify_workbook', 'discipline_audit',
    'check_xlsx', 'check_all_tables', 'check_cost_links', 'check_t89', 'fmt_check',
    'docx2pdf', 'closure_check', 'sysop_precheck', 'check_xlsx_style', 'dsh-restart',
  ]
  const cmdCounts = Object.create(null)
  const cmdNowCounts = Object.create(null)
  const writeCmds = []
  const writePaths = []
  const asstParts = []
  /** Write-ish shell verbs used to separate reads from writes in command text. */
  const WRITE_VERB = /(^|[\s;&|])(set-content|add-content|out-file|copy-item|move-item|remove-item|new-item|rename-item|rm|rmdir|del|cp|mv|mkdir|touch|tee)\b|>>?\s*[^&\s]|apply_patch/i
  /** 良性重定向不算写：2>/dev/null、>/dev/null、2>&1、2>$null（2026-11-18 修 D2 误报） */
  const BENIGN_REDIRECT = /[12]?>\s*(\/dev\/null|\$null)|2>&1/g
  let seenWrite = false
  let seenUser = false
  let writesAfterUser = 0
  const writesRecent = []
  let total = 0
  const seqEnd = Number(agent?.session?.seq ?? 0)
  const start = Math.max(0, seqEnd - limit)
  for (let seq = seqEnd - 1; seq >= start; seq -= 1) {
    let event
    try {
      event = agent.session.eventAt(seq)
    } catch {
      continue
    }
    if (!event) continue
    const t = event.time ?? 0
    if (event.type === 'tool/call') {
      total += 1
      const toolName = String(event.data?.name ?? 'unknown')
      facts['calls.byTool'][toolName] = (facts['calls.byTool'][toolName] ?? 0) + 1
      facts.hasTool[toolName] = true
      const args = event.data?.arguments
      const isShell = toolName === 'pwsh' || toolName === 'ops_bash' || toolName === 'bash'
      const commandText = isShell
        ? String(typeof args === 'string' ? args : (args?.command ?? ''))
        : ''
      /** 命令行里写文件（heredoc / > / cp / tee / Set-Content…）也算写过，2026-11-18 修 B3 误报 */
      const isShellWrite = Boolean(commandText) && WRITE_VERB.test(commandText.replace(BENIGN_REDIRECT, ' '))
      if (!seenUser && (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch' || isShellWrite)) {
        writesAfterUser += 1
        if (writesRecent.length < 20) {
          const target = isShell
            ? commandText
            : String(typeof args === 'string' ? args : (args?.file_path ?? args?.path ?? ''))
          if (target) writesRecent.push(target)
        }
      }
      if (!seenWrite) {
        if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch' || isShellWrite) seenWrite = true
        else facts['calls.sinceWrite'] += 1
      }
      if (isShell && commandText) {
        if (cmdParts.length < 30) cmdParts.push(commandText)
        if (writeCmds.length < 20 && isShellWrite) writeCmds.push(commandText.replace(BENIGN_REDIRECT, ' '))
        for (const key of SCRIPT_KEYS) {
          if (commandText.includes(key)) {
            cmdCounts[key] = (cmdCounts[key] ?? 0) + 1
            // Only counts matter for "did you run it this turn": a run from an
            // earlier turn must not keep a rule silent forever.
            if (!seenUser) cmdNowCounts[key] = (cmdNowCounts[key] ?? 0) + 1
          }
        }
      } else if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch') {
        const target = typeof args === 'string' ? args : (args?.file_path ?? args?.path ?? '')
        if (target && writePaths.length < 20) writePaths.push(String(target))
      }
      if (toolName === 'qq_notify' && facts.lastQQAt === null) facts.lastQQAt = t
      if ((toolName === 'write' || toolName === 'edit') && facts.lastProgressWriteAt === null) {
        const target = typeof args === 'string' ? args : (args?.file_path ?? args?.path ?? '')
        if (String(target).includes('进度-')) facts.lastProgressWriteAt = t
      }
    } else if (event.type === 'user/message') {
      seenUser = true
      for (const text of textsOf(event.data)) {
        if (facts.userLast === undefined) facts.userLast = text
        if (userParts.length < 5) userParts.push(text)
      }
      if (facts.firstUserAt === null) facts.firstUserAt = event.time ?? 0
    } else if (event.type === 'assistant/message') {
      // Only the most recent replies: stale phrasing must not keep firing rules.
      facts['replies.count'] += 1
      for (const text of textsOf(event.data)) {
        if (asstParts.length < 3) asstParts.push(text)
      }
    }
  }
  facts['calls.total'] = total
  facts['calls.sinceProgress'] = 0
  facts.cmd = cmdCounts
  facts.cmdNow = cmdNowCounts
  facts['cmd.qq_notify'] = cmdCounts.qq_notify ?? 0
  facts['text.userLast'] = facts.userLast ?? ''
  facts['text.commandsWrite'] = writeCmds.join('\n')
  facts['text.writePaths'] = writePaths.join('\n')
  facts['text.userAll'] = userParts.join('\n')
  facts['text.commands'] = cmdParts.join('\n')
  facts['text.assistant'] = asstParts.join('\n')
  facts['writes.afterUser'] = writesAfterUser
  facts['text.writesRecent'] = writesRecent.join('\n')
  facts['lastUser.question'] = /[?？]|能不能|可不可以|行不行|要不要|是不是该|你看呢|你觉得/.test(String(facts['text.userLast'] || ''))
  // "Said it, didn't do it": the claim sits in the reply, the proof has to sit in the facts.
  const asstText = facts['text.assistant']
  facts['claim.memory'] = /记(进|入|到|下)了?(卡|档)|写进.{0,6}(记忆|卡片?)|已落卡|落卡了/.test(asstText)
  facts['claim.run'] = /(跑|核|验)(过|完)了|门禁(过|通)|校验通过|已核对|对上了|复核无误|已验证|经核对一致/.test(asstText)
  // 我报出来的卡名，用来核对「说了写哪张卡」和「实际改了哪张卡」是否对得上
  facts['claim.memoryNames'] = Array.from(new Set(asstText.match(/[A-Za-z0-9_\-\u4e00-\u9fa5]+\.md/g) || []))
  return facts
}

/* ---------------------------------------------------------------- injection */

export async function apply(ctx, config = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const settings = {
    enabled: config.enabled !== false,
    rulesPath: config.rulesPath ?? path.join(here, 'rules', 'monitor-rules.json'),
    // The Harness process cwd is usually not the workspace; set `workspace`
    // explicitly in the profile config if it differs.
    workspace: config.workspace ?? process.cwd(),
    memoryDir: config.memoryDir ?? path.join(os.homedir(), '.sage-mem', 'memory'),
  }
  const perAgent = new WeakMap()
  ctx.logger?.info?.(`dsh-monitor active; rules=${settings.rulesPath}`)

  const stateFor = (agent) => {
    let state = perAgent.get(agent)
    if (!state) {
      state = { injections: 0, lastFired: new Map(), firedOnce: new Set() }
      perAgent.set(agent, state)
    }
    return state
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!settings.enabled) return decision
    if (!decision || decision.kind === 'reject') return decision
    const agent = payload?.agent
    if (!agent?.session) return decision
    let doc
    try {
      doc = loadRules(settings.rulesPath)
    } catch {
      return decision
    }
    if (!doc) return decision
    const now = Date.now()
    let flat
    try {
      const probe = probeWorkspace(settings.workspace, now)
      const mem = probeRecentWrites(settings.memoryDir, now, 60)
      probe.memory = { names: mem.names }
      flat = flatten(collect(agent), probe, now)
      flat['memory.writes60'] = mem.count
      flat['memory.names'] = mem.names.join(',')
    } catch {
      return decision
    }
    const state = stateFor(agent)
    const rule = decide(doc, flat, state, now, { ...doc.defaults, ...config })
    if (!rule) return decision
    const text = render(rule)
    let message
    try {
      message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
      })
    } catch {
      message = createUserMessage({ content: [{ type: 'text', text }] })
    }
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}
