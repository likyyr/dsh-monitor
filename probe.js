/**
 * Filesystem probe for the L1 supervisor.
 * Synchronous and small-file only — it runs inside a pre-step waterfall listener.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Local calendar date as YYYY-MM-DD. */
export function todayStamp(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function statOrNull(p) {
  try {
    const s = fs.statSync(p)
    return { exists: true, size: s.size, mtime: s.mtimeMs, isFile: s.isFile(), isDir: s.isDirectory() }
  } catch {
    return { exists: false, size: 0, mtime: 0, isFile: false, isDir: false }
  }
}

function readSmall(p, limit = 20000) {
  try {
    const buf = fs.readFileSync(p)
    return buf.subarray(0, limit).toString('utf8')
  } catch {
    return ''
  }
}

/** Read-only snapshot of the workspace facts the rules need. */
export function probeWorkspace(cwd, now = Date.now()) {
  const date = todayStamp(now)
  const tmpDir = path.join(cwd, '_tmp')
  const progressPath = path.join(tmpDir, `进度-${date}.md`)
  const progressStat = statOrNull(progressPath)
  const progressText = progressStat.exists ? readSmall(progressPath) : ''

  const rawDir = path.join(tmpDir, 'raw')
  let rawFiles = []
  const rawStat = statOrNull(rawDir)
  if (rawStat.isDir) {
    try {
      const dayStart = new Date(now)
      dayStart.setHours(0, 0, 0, 0)
      rawFiles = fs.readdirSync(rawDir)
        .map((name) => {
          const s = statOrNull(path.join(rawDir, name))
          return { name, size: s.size, mtime: s.mtime, isFile: s.isFile }
        })
        .filter((f) => f.isFile && f.mtime >= dayStart.getTime())
    } catch {
      rawFiles = []
    }
  }

  return {
    cwd,
    date,
    now,
    progress: {
      path: progressPath,
      exists: progressStat.exists,
      size: progressStat.size,
      mtime: progressStat.mtime,
      text: progressText,
    },
    raw: {
      dir: rawDir,
      exists: rawStat.isDir,
      todayFiles: rawFiles,
      count: rawFiles.length,
      totalBytes: rawFiles.reduce((a, f) => a + f.size, 0),
      maxBytes: rawFiles.reduce((a, f) => Math.max(a, f.size), 0),
    },
  }
}

/** True when `text` carries at least one digit run and one path-ish token. */
export function hasNumberAndPath(text) {
  return /\d{2,}/.test(text) && /[A-Za-z]:\\|\/|\.md|\.xlsx|\.docx|\.txt/.test(text)
}

/**
 * Files modified under `dir` since `windowMin` minutes ago.
 * Backs the "said it, didn't do it" checks: a claim about writing a memory card
 * has to leave an mtime behind, or it is just talk.
 */
export function probeRecentWrites(dir, now = Date.now(), windowMin = 60) {
  const cutoff = now - windowMin * 60000
  let hits = []
  try {
    hits = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => ({ name: n, mtime: statOrNull(path.join(dir, n)).mtime }))
      .filter((f) => f.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    hits = []
  }
  return {
    dir,
    windowMin,
    count: hits.length,
    names: hits.slice(0, 5).map((f) => f.name),
    latest: hits.length ? hits[0].mtime : 0,
  }
}

export { fs, path }
