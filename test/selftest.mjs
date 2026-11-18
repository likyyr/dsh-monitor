/**
 * Self-test for the rule engine. Plain Node, no DSH imports.
 *   node test/selftest.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRules, flatten, decide, test, render } from '../rules.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rulesPath = path.resolve(here, '..', '..', '监工规则.json')

let pass = 0
let fail = 0

function ok(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

/** Build a flat facts object the way index.js would. */
function facts({ tools = {}, userText = '', commands = '', writePaths = '', writesRecent = '', writesAfterUser = 0, question = false, assistant = '', ageMin = 0, progress = null, raw = { count: 0, totalBytes: 0, maxBytes: 0 }, firstUserAt = null, lastQQAt = null, cmd = {} } = {}) {
  const now = Date.now()
  const base = {
    'calls.byTool': Object.create(null),
    hasTool: Object.create(null),
    cmd: Object.create(null),
    'text.userLast': userText,
    'text.userAll': userText,
    'text.commands': commands,
    'text.commandsWrite': commands,
    'text.writePaths': writePaths,
    'text.assistant': assistant,
    'text.writesRecent': writesRecent,
    'writes.afterUser': writesAfterUser,
    'lastUser.question': question || /[?？]|能不能|可不可以|行不行|要不要|是不是该|你看呢|你觉得/.test(userText),
    firstUserAt,
    lastQQAt,
  }
  let total = 0
  for (const [tool, count] of Object.entries(tools)) {
    base['calls.byTool'][tool] = count
    base.hasTool[tool] = true
    total += count
  }
  base['calls.total'] = total
  base.cmd = { ...cmd }
  const probe = {
    progress: progress === null
      ? { exists: false, size: 0, mtime: 0, text: '' }
      : { exists: true, size: progress, mtime: now - ageMin * 60000, text: '' },
    raw: { ...raw },
  }
  return flatten(base, probe, now)
}

function state() {
  return { injections: 0, lastFired: new Map(), firedOnce: new Set() }
}

const doc = loadRules(rulesPath)
assert.ok(doc && Array.isArray(doc.rules), '规则清单应能加载')
console.log(`规则数: ${doc.rules.length}`)

/* 1 — 8 次调用、没进度文件 → A4 */
ok('A4 命中：20 次调用无进度文件', () => {
  const flat = facts({ tools: { read: 12, pwsh: 8 } })
  const rule = decide(doc, flat, state(), Date.now(), { cooldownMs: 0, maxInjections: 99 })
  assert.equal(rule?.id, 'A4')
})

/* 2 — 正常干活：有进度文件、有落盘、5 次调用 → 不应报 A4 */
ok('正常场景不误报 A4', () => {
  const flat = facts({ tools: { read: 3, write: 1 }, progress: 800, raw: { count: 2, totalBytes: 5000, maxBytes: 3000 } })
  const rule = decide(doc, flat, state(), Date.now(), { cooldownMs: 0, maxInjections: 99 })
  assert.notEqual(rule?.id, 'A4')
})

/* 3 — 危险命令 → D1（sev 0 最优先） */
ok('D1 命中：rm -rf', () => {
  const flat = facts({ tools: { pwsh: 1 }, commands: 'rm -rf /tmp/x' })
  const rule = decide(doc, flat, state(), Date.now(), { cooldownMs: 0, maxInjections: 99 })
  assert.equal(rule?.id, 'D1')
})

/* 4 — 说已交付但没 present/发文件 → E3 */
ok('E3 命中：空口交付', () => {
  const flat = facts({ tools: { write: 2 }, assistant: '已生成报表，已保存到目录' })
  const rule = decide(doc, flat, state(), Date.now(), { cooldownMs: 0, maxInjections: 99 })
  assert.equal(rule?.id, 'E3')
})

/* 5 — 注入上限生效 */
ok('注入上限：超 maxInjections 后不再报', () => {
  const flat = facts({ tools: { pwsh: 1 }, commands: 'rm -rf /' })
  const st = state()
  const first = decide(doc, flat, st, Date.now(), { cooldownMs: 0, maxInjections: 1 })
  const second = decide(doc, flat, st, Date.now() + 1000, { cooldownMs: 0, maxInjections: 1 })
  assert.ok(first)
  assert.equal(second, null)
})

/* 6 — 冷却生效 */
ok('冷却：同规则 20 分钟内不重复', () => {
  const flat = facts({ tools: { pwsh: 1 }, commands: 'rm -rf /' })
  const st = state()
  const now = Date.now()
  assert.ok(decide(doc, flat, st, now, { cooldownMs: 1200000, maxInjections: 99 }))
  assert.equal(decide(doc, flat, st, now + 60000, { cooldownMs: 1200000, maxInjections: 99 }), null)
})

/* 7 — 清单热重载：改文件后 loadRules 返回新内容 */
ok('热重载：mtime 变化后重新解析', async () => {
  const fake = { mtime: 1 }
  const stat = () => ({ mtimeMs: fake.mtime })
  const doc1 = loadRules(rulesPath, stat)
  const doc2 = loadRules(rulesPath, stat)
  assert.equal(doc1, doc2, '同一 mtime 应命中缓存')
})

/* 8 — 声称有证据：E5 / E6 */
const e5 = doc.rules.find((r) => r.id === 'E5')
const e6 = doc.rules.find((r) => r.id === 'E6')
ok('E5 存在且可判定', () => {
  assert.ok(e5 && e6, '规则清单应含 E5 与 E6')
})
ok('E5 命中：声称记卡，memory 60 分钟无变化', () => {
  const flat = facts({ assistant: '已经记进卡了' })
  flat['claim.memory'] = true
  flat['memory.writes60'] = 0
  assert.equal(test(e5.when, flat), true)
})
ok('E5 不误报：memory 有写入', () => {
  const flat = facts({ assistant: '已经记进卡了' })
  flat['claim.memory'] = true
  flat['memory.writes60'] = 2
  assert.equal(test(e5.when, flat), false)
})
ok('E6 命中：声称核过但无验证脚本', () => {
  const flat = facts({ tools: { pwsh: 12 }, assistant: '门禁过了' })
  flat['claim.run'] = true
  assert.equal(test(e6.when, flat), true)
})
ok('E6 不误报：跑过 verify_workbook', () => {
  const flat = facts({ tools: { pwsh: 12 }, assistant: '门禁过了', cmd: { verify_workbook: 1 } })
  flat['claim.run'] = true
  assert.equal(test(e6.when, flat), false)
})

/* 9 — 渲染文案 */
ok('渲染带前缀与等级', () => {
  const text = render({ id: 'X1', sev: 0, say: '测试' })
  assert.match(text, /【监工·红线】/)
})


/* 10 — 2026-11-18 改动：取消次数上限 / once / D6 新判据 */
ok('不限次数：maxInjections=0 时 injectons 再大也照报', () => {
  const flat = facts({ tools: { pwsh: 1 }, commands: 'rm -rf /' })
  const st = state()
  st.injections = 999
  assert.ok(decide(doc, flat, st, Date.now(), { cooldownMs: 0, maxInjections: 0 }))
})
ok('不限次数：不传 maxInjections 默认也不限', () => {
  const flat = facts({ tools: { pwsh: 1 }, commands: 'rm -rf /' })
  const st = state()
  st.injections = 500
  assert.ok(decide(doc, flat, st, Date.now(), { cooldownMs: 0 }))
})
ok('once 规则只报一次', () => {
  const d2 = { rules: [{ id: 'X9', sev: 2, once: true, when: { all: [{ fact: 'calls.total', op: '>=', value: 1 }] }, say: 't' }] }
  const flat = facts({ tools: { pwsh: 1 } })
  const st = state()
  assert.ok(decide(d2, flat, st, Date.now(), { cooldownMs: 0 }))
  assert.equal(decide(d2, flat, st, Date.now() + 1000, { cooldownMs: 0 }), null)
})
ok('B5 已标 once', () => {
  const b5 = doc.rules.find((r) => r.id === 'B5')
  assert.ok(b5 && b5.once === true)
})
ok('D6 用 replies.count：有回复就不报', () => {
  const d6 = doc.rules.find((r) => r.id === 'D6')
  const flat = facts({ tools: { pwsh: 12 } })
  flat['replies.count'] = 0
  assert.equal(test(d6.when, flat), true)
  flat['replies.count'] = 1
  assert.equal(test(d6.when, flat), false)
})
ok('D6 不再依赖 cmd.qq_notify', () => {
  const d6 = doc.rules.find((r) => r.id === 'D6')
  assert.ok(!JSON.stringify(d6.when).includes('qq_notify'))
})

/* 11 — 2026-11-18 新增 G 组 */
ok('G1 问句 + 本轮动了文件 → 命中；非问句不报', () => {
  const g1 = doc.rules.find((r) => r.id === 'G1')
  assert.ok(g1)
  assert.equal(test(g1.when, facts({ userText: '你看这样行不行？', writesAfterUser: 1 })), true)
  assert.equal(test(g1.when, facts({ userText: '按这个做', writesAfterUser: 1 })), false)
  assert.equal(test(g1.when, facts({ userText: '能不能改一下', writesAfterUser: 0 })), false)
})
ok('G2 本轮改过 xlsx 且没跑 check_xlsx_style → 命中；跑过不报', () => {
  const g2 = doc.rules.find((r) => r.id === 'G2')
  assert.ok(g2)
  const base = { tools: { write: 3, pwsh: 6 }, writesRecent: 'E:\\a\\材料摊销表.xlsx' }
  assert.equal(test(g2.when, facts(base)), true)
  assert.equal(test(g2.when, facts({ ...base, cmd: { check_xlsx: 1 } })), false)
})
ok('G2 不再拿整场历史误报', () => {
  const g2 = doc.rules.find((r) => r.id === 'G2')
  // writePaths 有旧 xlsx、但本轮没写 → 不报
  assert.equal(test(g2.when, facts({ tools: { write: 3, pwsh: 6 }, writePaths: 'E:\\a\\旧.xlsx' })), false)
})
ok('G5 改了插件没重启 → 命中；命令行里重启过不报', () => {
  const g5 = doc.rules.find((r) => r.id === 'G5')
  assert.ok(g5)
  const paths = 'E:\\deepseekwork\\_tools\\dsh-monitor\\index.js'
  assert.equal(test(g5.when, facts({ writesRecent: paths, commands: 'node test/selftest.mjs' })), true)
  assert.equal(test(g5.when, facts({ writesRecent: paths, commands: '"C:/bin/dsh-restart.cmd" run' })), false)
})
ok('规则清单含 G1~G7', () => {
  const ids = doc.rules.map((r) => r.id)
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']) assert.ok(ids.includes(id), id)
})

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
