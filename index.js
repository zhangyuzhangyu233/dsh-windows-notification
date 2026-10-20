/**
 * dsh-windows-notification — host half.
 *
 * Native Windows toast notifications for DeepSeek Harness, posted under the
 * harness's own AppUserModelID (`com.deepseek.dsh`) so they are attributed to
 * the DeepSeek Harness desktop app:
 *
 *   - `turn/end` completed → "task finished" toast with reply preview
 *   - `turn/end` error     → "task failed" toast with the error message
 *   - `approval/request`   → actionable toast (allow once / deny / open DSH)
 *     while the harness window is not foreground, answered through a local
 *     token-guarded HTTP bridge driven by the `dsh-notify:` protocol handler.
 *
 * The plugin is installed from a linked local directory, so this module is
 * dependency-free Node ESM: `node:` builtins only, no `@deepseek-ai/*` imports.
 * The host process runs as plain Node (ELECTRON_RUN_AS_NODE); the transport is
 * Windows PowerShell 5.1 + WinRT, delegated to the sibling `toast.ps1` /
 * `setup-protocol.ps1` scripts (see docs/INTERNALS.md for the contracts).
 *
 * @module dsh-windows-notification
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin display name. */
export const name = 'dsh-windows-notification'

/** Settings namespace consumed by the Settings → Plugins card. */
const SETTINGS_NAMESPACE = 'windows-notification'
/** AppUserModelID registered for the DeepSeek Harness Start Menu entry. */
const AUMID = 'com.deepseek.dsh'
/** Local bridge request-body cap (bytes). */
const MAX_BODY_BYTES = 4096
/**
 * Deterministic loopback UI-port candidates: the bridge binds the first free
 * one so the local web page can discover it by scanning.
 * - 49514..49522: the contract's primary range;
 * - 49714..49722: fallback just outside Windows' excluded dynamic ranges on the
 *   target machine (49510..49609 is reserved there, so the primary range binds
 *   EACCES — the bridge must still land deterministically);
 * - 48080..48088: static (below the Windows dynamic port range) last resort.
 */
const UI_PORT_CANDIDATES = Object.freeze([
  49514, 49515, 49516, 49517, 49518, 49519, 49520, 49521, 49522,
  49714, 49715, 49716, 49717, 49718, 49719, 49720, 49721, 49722,
  48080, 48081, 48082, 48083, 48084, 48085, 48086, 48087, 48088,
])
/** Loopback http(s) browser origins allowed to call the local `/ui/*` surface. */
const UI_HTTP_ORIGIN_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i
/**
 * Desktop renderer origin: the 0.2.x desktop app loads its UI from the
 * `dsh-app://` scheme (e.g. `Origin: dsh-app://app`), so that scheme is allowed
 * for any host it names. Other schemes/hosts are still rejected.
 */
const UI_APP_ORIGIN_PATTERN = /^dsh-app:\/\/[A-Za-z0-9.-]+(:\d+)?$/i
/** Per-route `/ui/*` rate limit (fixed window). */
const UI_RATE_LIMIT = Object.freeze({ max: 5, windowMs: 10000 })
/** Foreground-check cache lifetime (ms). */
const FOREGROUND_TTL_MS = 750
/** Hard timeouts for the PowerShell children (ms). */
const CHECK_TIMEOUT_MS = 4000
const TOAST_TIMEOUT_MS = 8000
const SETUP_TIMEOUT_MS = 20000
/** Plugin directory (holds toast.ps1 / setup-protocol.ps1 / notify-handler.ps1). */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
/** Windows PowerShell 5.1 only, per contract. */
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
/** Plugin version reported by `/ui/health` (from the shipped package.json). */
const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Mutable seams used only by the offline verification harness
 * (`.verify/notification/host/sim.mjs`). Production code never mutates this
 * object; every field defaults to the real runtime dependency.
 */
export const __internals = {
  spawn: nodeSpawn,
  spawnSync: nodeSpawnSync,
  platform: () => process.platform,
  now: () => Date.now(),
  localAppDataDir: () => {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(base, 'dsh-windows-notification')
  },
  /** Whether one socket peer address is loopback (used by the /ui surface). */
  isLoopbackPeer: (address) => {
    const normalized = String(address || '').toLowerCase()
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
  },
  /** Ordered loopback ports the bridge tries (test harness may replace this list). */
  uiPortCandidates: UI_PORT_CANDIDATES,
}

/** Default settings values (mirrors the embedded schemastery envelope). */
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  onTurnComplete: true,
  onApproval: true,
  onError: true,
  skipWhenForeground: true,
  includePreview: true,
  sound: 'default',
  approvalActions: true,
  approvalTimeoutSec: 30,
  maxPreviewChars: 180,
  testPing: 0,
  // v1.1 — user questions + demo notifications
  onUserQuestion: true,
  questionActions: true,
  questionTimeoutSec: 60,
  demoKind: 'question-options',
  demoPing: 0,
  // v1.2 — smarter push
  smartSummary: true,
  sessionCollapse: true,
})

/** Every accepted `demoKind` value (v1.1). */
const DEMO_KINDS = Object.freeze(['complete', 'approval', 'question-options', 'question-text'])

// ---------------------------------------------------------------------------
// v1.3 — desktop runtime (0.2.x) Config schema
// ---------------------------------------------------------------------------

/**
 * Resolve the host runtime's own Schemastery instance without a bare import.
 * Both supported runtimes resolve it from the process entry file: the desktop
 * host's `process.argv[1]` lives inside `app.asar`, the npm dsh one is
 * `dsh/lib/bin.js`. When the entry file cannot resolve it (Electron argv[1]
 * pointing elsewhere, plain Node unit tests) the packaged desktop runtime path
 * is tried next on Electron. Returns null when nothing resolves — the loader
 * then simply has no Config schema, as before.
 */
function runtimeSchemasteryBases() {
  const bases = []
  try {
    if (typeof process.argv[1] === 'string' && process.argv[1]) bases.push(process.argv[1])
    else bases.push(join(process.cwd(), 'x.js'))
  } catch {
    try {
      bases.push(join(process.cwd(), 'x.js'))
    } catch {
      /* ignore */
    }
  }
  try {
    // Electron: <app>/resources/app.asar/dsh/node_modules holds the runtime deps.
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
      bases.push(join(process.resourcesPath, 'app.asar', 'dsh', 'lib', 'bin.js'))
    }
  } catch {
    /* ignore */
  }
  return bases
}

function resolveRuntimeSchemastery() {
  for (const base of runtimeSchemasteryBases()) {
    try {
      const require = createRequire(base)
      const loaded = require('@deepseek-ai/schemastery')
      const z = loaded && (loaded.default ?? loaded)
      if (typeof z === 'function' && typeof z.object === 'function') return z
    } catch {
      /* try the next basis */
    }
  }
  return null
}

/**
 * Per-loader-entry `Config` form schema for the 18 settings fields (0.2.x
 * desktop runtime: `SettingsForms.schema(entry)` reads `fiber.runtime.Config`,
 * and only a schema whose root declares `meta.volatile` is shown as a form).
 * Undefined when the host's Schemastery cannot be resolved.
 */
function buildConfigSchema() {
  const z = resolveRuntimeSchemastery()
  if (!z) return undefined
  try {
    const boolean = (fallback, description) => z.boolean().default(fallback).description(description)
    const natural = (min, max, fallback, description) =>
      z.natural().min(min).max(max).default(fallback).description(description)
    return z
      .object({
        enabled: boolean(true, '总开关：是否发送系统通知 / Master switch'),
        onTurnComplete: boolean(true, '任务完成时通知 / Notify when a turn completes'),
        onApproval: boolean(true, '请求审批时通知 / Notify when an approval is requested'),
        onError: boolean(true, '会话出错时通知 / Notify when a turn fails'),
        skipWhenForeground: boolean(true, 'DeepSeek Harness 在前台时不打扰 / Skip while the window is foreground'),
        includePreview: boolean(true, '在通知中包含回复预览 / Include the reply preview'),
        sound: z.union(['default', 'silent']).default('default').description('提示音 / Toast sound'),
        approvalActions: boolean(true, '应用不在前台时可在通知里处理审批 / Answer approvals from the toast'),
        approvalTimeoutSec: natural(5, 300, 30, '审批通知等待秒数 / Approval toast timeout (seconds)'),
        maxPreviewChars: natural(40, 500, 180, '预览最多字符数 / Preview length cap'),
        testPing: z.natural().default(0).description('测试通知的写入触发器 / Write-only test trigger (epoch ms)'),
        onUserQuestion: boolean(true, 'Agent 提问时通知 / Notify when the agent asks a question'),
        questionActions: boolean(true, '应用不在前台时可从通知回答问题 / Answer questions from the toast'),
        questionTimeoutSec: natural(10, 600, 60, '问题通知等待秒数 / Question toast timeout (seconds)'),
        demoKind: z
          .union(['complete', 'approval', 'question-options', 'question-text'])
          .default('question-options')
          .description('演示通知类型 / Demo notification kind'),
        demoPing: z.natural().default(0).description('演示通知的写入触发器 / Write-only demo trigger (epoch ms)'),
        smartSummary: boolean(true, '智能摘要：用时/步数/工具调用 + 清理后的预览 / Smart summary'),
        sessionCollapse: boolean(true, '同一会话的通知合并替换 / Collapse notifications per session'),
      })
      .description('Windows 通知 / Windows Notification')
      .extra('volatile', true)
  } catch (error) {
    try {
      console.warn(
        '[dsh-windows-notification] could not build the Config schema:',
        error && error.message ? error.message : error,
      )
    } catch {
      /* logging must never break module init */
    }
    return undefined
  }
}

/**
 * Loader-facing Config schema: the desktop (0.2.x) settings page renders this
 * as the plugin's configuration form. `undefined` when Schemastery cannot be
 * resolved in this host, which only means the form is absent (old behavior).
 */
export const Config = buildConfigSchema()

if (Config === undefined) {
  try {
    console.warn(
      '[dsh-windows-notification] @deepseek-ai/schemastery is unavailable in this host runtime; the plugin Config form is disabled',
    )
  } catch {
    /* logging must never break module init */
  }
}

/**
 * Serialized Schemastery envelope for the settings namespace. Generated offline
 * from `@deepseek-ai/schemastery@3.18.2` by
 * `.verify/notification/host/gen-schema.mjs` (the client rehydrates it with
 * `new Schema(json)`); the host never imports schemastery.
 */
const SETTINGS_SCHEMA_ENVELOPE = {
  uid: 64,
  refs: {
    1: { type: 'boolean', meta: { default: true } },
    3: { type: 'boolean', meta: { default: true } },
    5: { type: 'boolean', meta: { default: true } },
    7: { type: 'boolean', meta: { default: true } },
    9: { type: 'boolean', meta: { default: true } },
    11: { type: 'boolean', meta: { default: true } },
    14: { type: 'const', meta: { required: true }, value: 'default' },
    16: { type: 'const', meta: { required: true }, value: 'silent' },
    17: { type: 'union', meta: { default: 'default' }, list: [14, 16] },
    19: { type: 'boolean', meta: { default: true } },
    25: { type: 'number', meta: { step: 1, min: 5, max: 300, default: 30 } },
    31: { type: 'number', meta: { step: 1, min: 40, max: 500, default: 180 } },
    35: { type: 'number', meta: { step: 1, min: 0, default: 0 } },
    37: { type: 'boolean', meta: { default: true } },
    39: { type: 'boolean', meta: { default: true } },
    45: { type: 'number', meta: { step: 1, min: 10, max: 600, default: 60 } },
    48: { type: 'const', meta: { required: true }, value: 'complete' },
    50: { type: 'const', meta: { required: true }, value: 'approval' },
    52: { type: 'const', meta: { required: true }, value: 'question-options' },
    54: { type: 'const', meta: { required: true }, value: 'question-text' },
    55: { type: 'union', meta: { default: 'question-options' }, list: [48, 50, 52, 54] },
    59: { type: 'number', meta: { step: 1, min: 0, default: 0 } },
    61: { type: 'boolean', meta: { default: true } },
    63: { type: 'boolean', meta: { default: true } },
    64: {
      type: 'object',
      meta: { default: {} },
      dict: {
        enabled: 1,
        onTurnComplete: 3,
        onApproval: 5,
        onError: 7,
        skipWhenForeground: 9,
        includePreview: 11,
        sound: 17,
        approvalActions: 19,
        approvalTimeoutSec: 25,
        maxPreviewChars: 31,
        testPing: 35,
        onUserQuestion: 37,
        questionActions: 39,
        questionTimeoutSec: 45,
        demoKind: 55,
        demoPing: 59,
        smartSummary: 61,
        sessionCollapse: 63,
      },
    },
  },
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/** Whether a value is a plain object record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce a value into a bounded integer, falling back when unusable. */
function clampInt(value, min, max, fallback) {
  let numeric = NaN
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/** Boolean-or-default normalization. */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Collapse whitespace and clip a string to `max` characters (ellipsis included). */
function clip(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const limit = Math.max(1, Math.round(max))
  if (collapsed.length <= limit) return collapsed
  return collapsed.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

/** XML-escape text and attribute values. */
function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Unwrap a Schemastery 3.18.5 "volatile" Config value (desktop 0.2.x): when the
 * Config root declares `meta.volatile`, schema resolution returns a live value
 * object (`{ get(), [Symbol.for('cosmokit.volatile.write')] }`) instead of a
 * plain record. Both runtimes must end up with plain data here.
 */
function unwrapConfigValue(value) {
  try {
    if (value && typeof value === 'object' && typeof value.get === 'function') {
      const symbols = Object.getOwnPropertySymbols(value)
      if (symbols.some((symbol) => String(symbol).includes('cosmokit.volatile.write'))) return value.get()
    }
  } catch {
    /* fall through to the value itself */
  }
  return value
}

/** Normalize a settings-like value into the complete 18-field shape. */
function normalizeSettings(input) {
  const unwrapped = unwrapConfigValue(input)
  const value = isRecord(unwrapped) ? unwrapped : {}
  return {
    enabled: booleanOr(value.enabled, DEFAULT_SETTINGS.enabled),
    onTurnComplete: booleanOr(value.onTurnComplete, DEFAULT_SETTINGS.onTurnComplete),
    onApproval: booleanOr(value.onApproval, DEFAULT_SETTINGS.onApproval),
    onError: booleanOr(value.onError, DEFAULT_SETTINGS.onError),
    skipWhenForeground: booleanOr(value.skipWhenForeground, DEFAULT_SETTINGS.skipWhenForeground),
    includePreview: booleanOr(value.includePreview, DEFAULT_SETTINGS.includePreview),
    sound: value.sound === 'silent' ? 'silent' : 'default',
    approvalActions: booleanOr(value.approvalActions, DEFAULT_SETTINGS.approvalActions),
    approvalTimeoutSec: clampInt(value.approvalTimeoutSec, 5, 300, DEFAULT_SETTINGS.approvalTimeoutSec),
    maxPreviewChars: clampInt(value.maxPreviewChars, 40, 500, DEFAULT_SETTINGS.maxPreviewChars),
    testPing: clampInt(value.testPing, 0, Number.MAX_SAFE_INTEGER, 0),
    onUserQuestion: booleanOr(value.onUserQuestion, DEFAULT_SETTINGS.onUserQuestion),
    questionActions: booleanOr(value.questionActions, DEFAULT_SETTINGS.questionActions),
    questionTimeoutSec: clampInt(value.questionTimeoutSec, 10, 600, DEFAULT_SETTINGS.questionTimeoutSec),
    demoKind: DEMO_KINDS.includes(value.demoKind) ? value.demoKind : DEFAULT_SETTINGS.demoKind,
    demoPing: clampInt(value.demoPing, 0, Number.MAX_SAFE_INTEGER, 0),
    smartSummary: booleanOr(value.smartSummary, DEFAULT_SETTINGS.smartSummary),
    sessionCollapse: booleanOr(value.sessionCollapse, DEFAULT_SETTINGS.sessionCollapse),
  }
}

// ---------------------------------------------------------------------------
// v1.2 — smart summary helpers (duration / per-turn telemetry / preview cleaning)
// ---------------------------------------------------------------------------

/** Humanize a duration in milliseconds (`42 秒`, `1 分 12 秒`). */
function humanizeDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds) / 1000) || 0)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
}

/** One-line turn summary: `用时 1 分 12 秒 · 2 步 · 3 次工具调用（bash、grep）`. */
function turnSummaryLine(stats) {
  if (!isRecord(stats)) return ''
  const parts = []
  if (Number.isFinite(stats.durationMs) && stats.durationMs >= 0) parts.push(`用时 ${humanizeDuration(stats.durationMs)}`)
  if (Number.isFinite(stats.steps) && stats.steps > 0) parts.push(`${stats.steps} 步`)
  if (Number.isFinite(stats.toolCalls) && stats.toolCalls > 0) {
    let toolPart = `${stats.toolCalls} 次工具调用`
    if (Array.isArray(stats.toolNames) && stats.toolNames.length > 0) toolPart += `（${stats.toolNames.join('、')}）`
    parts.push(toolPart)
  }
  return parts.join(' · ')
}

/** Strip fenced-code markers, markdown links/images/headings and collapse whitespace. */
function cleanPreviewText(text) {
  let value = typeof text === 'string' ? text : text == null ? '' : String(text)
  value = value.replace(/```[A-Za-z0-9_+.-]*/g, '') // fenced-code markers (open and close)
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image syntax -> alt text
  value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown link -> label
  value = value.replace(/^[ \t]*#{1,6}[ \t]+/gm, '') // heading marks
  value = value.replace(/[ \t]*\r?\n[ \t]*/g, ' ') // newlines -> spaces
  value = value.replace(/\s+/g, ' ').trim()
  return value
}

/** Clip text to `max` code points, preferring a word boundary, with a trailing ellipsis. */
function clipAtBoundary(text, max) {
  const limit = Math.max(1, Math.round(max))
  const chars = Array.from(String(text == null ? '' : text))
  if (chars.length <= limit) return chars.join('')
  const joined = chars.slice(0, Math.max(1, limit - 1)).join('')
  const lastSpace = joined.search(/\s\S*$/)
  const cut = lastSpace > Math.floor(joined.length * 0.6) ? joined.slice(0, lastSpace) : joined
  return `${cut.trimEnd()}…`
}

/**
 * Host-side settings schema: callable normalizer whose `toJSON()` returns the
 * serialized Schemastery envelope the settings service sends to the client.
 */
function createSettingsSchema() {
  const schema = function settingsSchema(value) {
    return normalizeSettings(value)
  }
  schema.toJSON = () => JSON.parse(JSON.stringify(SETTINGS_SCHEMA_ENVELOPE))
  return schema
}

const SETTINGS_SCHEMA = createSettingsSchema()

/** Log through the cordis logger (falling back to console). Never throws. */
function logTo(ctx, level, message, error) {
  try {
    const logger = ctx && ctx.logger
    const method = logger && logger[level]
    if (typeof method === 'function') {
      if (error !== undefined) method.call(logger, message, error)
      else method.call(logger, message)
      return
    }
    if (level === 'error') console.error('[dsh-windows-notification]', message, error === undefined ? '' : error)
    else if (level === 'warn') console.warn('[dsh-windows-notification]', message, error === undefined ? '' : error)
  } catch {
    /* logging must never break a listener */
  }
}

/** Build a Tag value bounded to the WinRT 64-character limit. */
function toastTag(prefix, detail) {
  const raw = detail ? `${prefix}-${detail}` : String(prefix || 'dsh')
  return raw.length > 64 ? raw.slice(0, 64) : raw
}

/**
 * Stable 32-bit FNV-1a hash (8 hex chars) of a session id. Session ids share the
 * `session-<uuid>` shape, so a plain prefix slice would collapse every session
 * onto the same Tag and make sibling sessions replace each other's notifications.
 * @param value - session id (or any stable string).
 * @returns hex digest string.
 */
function stableHash8(value) {
  let hash = 0x811c9dc5
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Session-collapse Tag: one stable per-session notification slot. */
function sessionCollapseTag(sessionId) {
  return toastTag('sess', stableHash8(sessionId))
}

/** Parse the last JSON object line printed by a PowerShell script. */
function parseLastJsonLine(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line.length === 0 || line[0] !== '{') continue
    try {
      const value = JSON.parse(line)
      if (isRecord(value)) return value
    } catch {
      /* keep scanning upwards */
    }
  }
  return null
}

/** Constant-time token comparison (length check first, both strings). */
function tokensEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  if (candidate.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// PowerShell child processes
// ---------------------------------------------------------------------------

/** Kill one PowerShell child and its process tree (best effort). */
function killTree(state, child) {
  if (!child) return
  try {
    child.kill?.('SIGKILL')
  } catch {
    /* already gone */
  }
  const pid = child.pid
  if (pid) {
    try {
      __internals.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      /* taskkill unavailable; the direct kill above is the fallback */
    }
  }
}

/**
 * Run one sibling PowerShell script with a hard timeout. Resolves with
 * `{ ok, code, stdout, stderr, json }` — never rejects.
 */
function runPowerShell(state, scriptName, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let child = null
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (child) state.children.delete(child)
      resolve(value)
    }
    try {
      child = __internals.spawn(
        POWERSHELL,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          join(PLUGIN_DIR, scriptName),
          ...args,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      finish({ ok: false, error: String(error && error.message ? error.message : error), stdout: '', stderr: '', json: null })
      return
    }
    if (!child) {
      finish({ ok: false, error: 'spawn-failed', stdout: '', stderr: '', json: null })
      return
    }
    state.children.add(child)
    let stdout = ''
    let stderr = ''
    timer = setTimeout(() => {
      killTree(state, child)
      finish({ ok: false, error: 'timeout', stdout, stderr, json: null })
    }, Math.max(250, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
    try {
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on?.('error', (error) => {
        finish({ ok: false, error: String(error && error.message ? error.message : error), stdout, stderr, json: null })
      })
      child.on?.('close', (code) => {
        finish({ ok: true, code, stdout, stderr, json: parseLastJsonLine(stdout) })
      })
    } catch (error) {
      finish({ ok: false, error: String(error && error.message ? error.message : error), stdout, stderr, json: null })
    }
  })
}

// ---------------------------------------------------------------------------
// Toast XML construction
// ---------------------------------------------------------------------------

/** Build one toast XML document (toast.ps1 only displays it). */
function buildToastXml({ header, title, body, actions, sound, input }) {
  const parts = ['<toast duration="long">', '<visual><binding template="ToastGeneric">']
  parts.push(`<text>${escapeXml(header || 'DeepSeek Harness')}</text>`)
  if (title) parts.push(`<text>${escapeXml(title)}</text>`)
  if (body) parts.push(`<text>${escapeXml(body)}</text>`)
  parts.push('</binding></visual>')
  if (sound === 'silent') parts.push('<audio silent="true"/>')
  else parts.push('<audio src="ms-winsoundevent:Notification.Default" loop="false"/>')
  if (input || (Array.isArray(actions) && actions.length > 0)) {
    parts.push('<actions>')
    if (input) {
      parts.push(
        `<input id="${escapeXml(input.id || 'reply')}" type="text" placeHolderContent="${escapeXml(
          input.placeholder || '输入回答…',
        )}"/>`,
      )
    }
    for (const action of Array.isArray(actions) ? actions : []) {
      const hint = action.hintInputId ? ` hint-inputId="${escapeXml(action.hintInputId)}"` : ''
      parts.push(
        `<action content="${escapeXml(action.content)}" activationType="${escapeXml(
          action.activationType,
        )}" arguments="${escapeXml(action.arguments)}"${hint}/>`,
      )
    }
    parts.push('</actions>')
  }
  parts.push('</toast>')
  return parts.join('')
}

/** Protocol action that opens / focuses DeepSeek Harness. */
function openAction(sessionId) {
  return {
    content: '打开 DSH',
    activationType: 'protocol',
    arguments: `dsh-notify://open?session=${encodeURIComponent(sessionId || '')}`,
  }
}

/** System action that dismisses the notification. */
function dismissAction() {
  return { content: '知道了', activationType: 'system', arguments: 'dismiss' }
}

/** Protocol action that answers one pending approval through the bridge. */
function decisionAction(content, action, approvalId, sessionId) {
  return {
    content,
    activationType: 'protocol',
    arguments: `dsh-notify://decision?action=${action}&approval=${encodeURIComponent(
      approvalId,
    )}&session=${encodeURIComponent(sessionId || '')}`,
  }
}

/**
 * Toast for a completed / failed turn. v1.2: when `smartSummary` is on, the body
 * gets a telemetry summary line plus a cleaned preview (completed) or the error
 * code + message + summary line (error).
 */
function buildTurnEndToastXml({ cfg, kind, sessionTitle, preview, errorMessage, errorCode, summaryLine, sessionId }) {
  const title = clip(sessionTitle || (kind === 'completed' ? '任务已完成' : '会话出错'), 72)
  const heading = kind === 'completed' ? '任务完成' : '会话出错'
  const smart = Boolean(cfg.smartSummary)
  let body
  if (kind === 'completed') {
    if (smart && summaryLine) {
      const cleaned = cfg.includePreview && preview ? cleanPreviewText(preview) : ''
      body = cleaned ? `${summaryLine}\n${clipAtBoundary(cleaned, cfg.maxPreviewChars)}` : summaryLine
    } else {
      body = cfg.includePreview && preview ? clip(preview, cfg.maxPreviewChars) : '会话已完成，等待你的下一步。'
    }
  } else {
    const message = clip(errorMessage || '未知错误', cfg.maxPreviewChars)
    if (smart) {
      const codeLine = errorCode ? `【${errorCode}】${message}` : message
      body = summaryLine ? `${codeLine}\n${summaryLine}` : codeLine
    } else {
      body = message
    }
  }
  return buildToastXml({
    header: 'DeepSeek Harness',
    title: `${heading} · ${title}`,
    body,
    actions: [openAction(sessionId), dismissAction()],
    sound: cfg.sound,
  })
}

/** Toast asking the user to approve or deny one request. */
function buildApprovalToastXml({ cfg, toolName, reason, approvalId, sessionId }) {
  const ask = toolName ? `工具 ${clip(toolName, 60)} 请求审批` : '有新的审批请求'
  const detail = reason ? clip(reason, cfg.maxPreviewChars) : '请选择允许一次或拒绝；忽略则回到应用内确认。'
  return buildToastXml({
    header: 'DeepSeek Harness',
    title: '需要你的确认',
    body: `${ask}：${detail}`,
    actions: [
      decisionAction('允许一次', 'approve', approvalId, sessionId),
      decisionAction('拒绝', 'deny', approvalId, sessionId),
      openAction(sessionId),
    ],
    sound: cfg.sound,
  })
}

/** Toast for one model-requested custom notification. */
function buildCustomToastXml({ cfg, title, body, actionsMode, sessionId }) {
  const actions = []
  if (actionsMode === 'open') actions.push(openAction(sessionId))
  if (actionsMode !== 'none') actions.push(dismissAction())
  return buildToastXml({
    header: 'DeepSeek Harness',
    title: clip(title, 200),
    body: clip(body, 200),
    actions,
    sound: cfg.sound,
  })
}

/** Fixed confirmation toasts (settings enable / test ping). */
function buildConfirmationToastXml({ cfg, title, body }) {
  return buildToastXml({
    header: 'DeepSeek Harness',
    title,
    body,
    actions: [dismissAction()],
    sound: cfg.sound,
  })
}

// ---------------------------------------------------------------------------
// v1.1 — user-question + demo toast XML
// ---------------------------------------------------------------------------

/** Protocol action carrying one answered question option through the handler. */
function questionOptionAction(label, questionToken, choice, sessionId) {
  return {
    content: clip(label, 42),
    activationType: 'protocol',
    arguments: `dsh-notify://question?action=option&question=${encodeURIComponent(
      questionToken,
    )}&choice=${encodeURIComponent(String(choice))}&session=${encodeURIComponent(sessionId || '')}&focus=0`,
  }
}

/** Protocol action that answers a free-text question with the toast input value. */
function questionTextAction(questionToken, sessionId) {
  return {
    content: '发送',
    activationType: 'protocol',
    arguments: `dsh-notify://question?action=text&question=${encodeURIComponent(
      questionToken,
    )}&session=${encodeURIComponent(sessionId || '')}&focus=0`,
    hintInputId: 'reply',
  }
}

/** Protocol action that opens the in-app question UI (and focuses the harness). */
function questionOpenAction(questionToken, sessionId) {
  return {
    content: '打开 DSH',
    activationType: 'protocol',
    arguments: `dsh-notify://question?action=open&question=${encodeURIComponent(
      questionToken,
    )}&session=${encodeURIComponent(sessionId || '')}`,
  }
}

/** Toast for a single-select question with options (up to three option buttons). */
function buildQuestionOptionsToastXml({ cfg, question, questionToken, sessionId }) {
  const text = clip(question.question, 220)
  const detail = question.detail ? clip(question.detail, Math.max(40, cfg.maxPreviewChars)) : ''
  const options = Array.isArray(question.options) ? question.options.slice(0, 3) : []
  const actions = options.map((option, index) =>
    questionOptionAction(option && typeof option.label === 'string' ? option.label : `选项 ${index + 1}`, questionToken, index, sessionId),
  )
  actions.push(questionOpenAction(questionToken, sessionId))
  // v1.2: the body names the options up front so the notification is readable
  // even when the banner truncates or the buttons are collapsed.
  const baseBody = detail ? `${text} — ${detail}` : text
  const overview = options.length > 0 ? `选项：${options.map((option) => clip(option.label, 24)).join(' / ')}` : ''
  return buildToastXml({
    header: 'DeepSeek Harness',
    title: question.header ? `需要你的选择 · ${clip(question.header, 40)}` : '需要你的选择',
    body: overview ? `${baseBody}\n${overview}` : baseBody,
    actions,
    sound: cfg.sound,
  })
}

/** Toast for a single question with no options (free-text answer through the input). */
function buildQuestionTextToastXml({ cfg, question, questionToken, sessionId }) {
  const text = clip(question.question, 220)
  const detail = question.detail ? clip(question.detail, Math.max(40, cfg.maxPreviewChars)) : ''
  return buildToastXml({
    header: 'DeepSeek Harness',
    title: question.header ? `需要你的输入 · ${clip(question.header, 40)}` : '需要你的输入',
    body: detail ? `${text} — ${detail}` : text,
    input: { id: 'reply', placeholder: '输入回答…' },
    actions: [questionTextAction(questionToken, sessionId)],
    sound: cfg.sound,
  })
}

/** Notify-only toast for multi-question / multi-select requests (never claimed). */
function buildQuestionNoticeToastXml({ cfg, questions, sessionId }) {
  const first = questions[0] || {}
  const count = questions.length
  const title = count > 1 ? `有 ${count} 个问题等待回答` : '请选择答案'
  const body = first.question ? clip(first.question, Math.max(60, cfg.maxPreviewChars)) : '请在 DeepSeek Harness 中回答问题。'
  return buildToastXml({
    header: 'DeepSeek Harness',
    title,
    body,
    actions: [openAction(sessionId)],
    sound: cfg.sound,
  })
}

/** Demo action for the approval demo (demo URI, no real approval is created). */
function demoApprovalAction(label, decision) {
  return {
    content: label,
    activationType: 'protocol',
    arguments: `dsh-notify://demo?kind=approval&decision=${decision}&focus=0`,
  }
}

/** Demo action for the option demo (choice index instead of a real answer). */
function demoOptionAction(label, choice) {
  return {
    content: clip(label, 42),
    activationType: 'protocol',
    arguments: `dsh-notify://demo?kind=question-options&choice=${encodeURIComponent(String(choice))}&focus=0`,
  }
}

/** Demo action for the text demo (input value rides back as `reply`). */
function demoTextAction() {
  return {
    content: '发送',
    activationType: 'protocol',
    arguments: 'dsh-notify://demo?kind=question-text&focus=0',
    hintInputId: 'reply',
  }
}

/**
 * One demo toast per `demoKind`. Demos are explicit user actions, so they are
 * never suppressed by the foreground check.
 */
function buildDemoToastXml({ cfg, demoKind }) {
  switch (demoKind) {
    case 'complete':
      return buildTurnEndToastXml({
        cfg,
        kind: 'completed',
        sessionTitle: '演示会话',
        preview: '这是一条演示通知：你的任务已经完成，点击「打开 DSH」回到应用。',
        errorMessage: '',
        sessionId: 'demo-complete',
      })
    case 'approval':
      return buildToastXml({
        header: 'DeepSeek Harness',
        title: '需要你的确认（演示）',
        body: '演示：工具 bash 请求执行权限，请选择允许一次或拒绝。不会创建真实审批。',
        actions: [demoApprovalAction('允许一次', 'approve'), demoApprovalAction('拒绝', 'deny')],
        sound: cfg.sound,
      })
    case 'question-text':
      return buildToastXml({
        header: 'DeepSeek Harness',
        title: '需要你的输入（演示）',
        body: '演示：请在通知输入框中输入一段回答，然后点击「发送」。',
        input: { id: 'reply', placeholder: '输入演示回答…' },
        actions: [demoTextAction()],
        sound: cfg.sound,
      })
    case 'question-options':
    default:
      return buildToastXml({
        header: 'DeepSeek Harness',
        title: '需要你的选择（演示）',
        body: '演示：请选择一个方案（方案 A / 方案 B / 稍后处理）。不会创建真实问题。',
        actions: [demoOptionAction('方案 A', 0), demoOptionAction('方案 B', 1), demoOptionAction('稍后处理', 2)],
        sound: cfg.sound,
      })
  }
}

/** Follow-up confirmation posted when the bridge receives a demo activation. */
function buildDemoResultToastXml({ cfg, title, body }) {
  return buildToastXml({
    header: 'DeepSeek Harness',
    title,
    body,
    actions: [dismissAction()],
    sound: cfg.sound,
  })
}

// ---------------------------------------------------------------------------
// Toast queue + PowerShell display / foreground check
// ---------------------------------------------------------------------------

/** Serialize toast spawns so a burst does not spawn dozens of processes. */
function enqueueToast(state, options) {
  const run = () => {
    if (state.disposed) return Promise.resolve({ shown: false, reason: 'disposed' })
    return showToast(state, options)
  }
  const queued = state.toastChain.then(run, run)
  state.toastChain = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

/** Spawn toast.ps1 for one XML document and interpret its JSON line. */
async function showToast(state, options) {
  const xml = options.xml
  const base64 = Buffer.from(String(xml), 'utf8').toString('base64')
  const args = ['-XmlBase64', base64, '-Aumid', AUMID]
  if (options.tag) args.push('-Tag', options.tag)
  if (options.skipWhenForeground) args.push('-SkipWhenForeground')
  // Approval prompts are urgent: Win11 priority toasts can break through Do Not
  // Disturb when the user has allowed DeepSeek Harness (otherwise it is a no-op).
  if (options.priority === 'high') args.push('-Priority', 'high')
  const result = await runPowerShell(state, 'toast.ps1', args, TOAST_TIMEOUT_MS)
  if (!result.ok) {
    logTo(state.ctx, 'warn', `toast.ps1 failed: ${result.error || 'unknown error'}`)
    return { shown: false, reason: result.error || 'failed' }
  }
  const json = result.json
  if (!json || json.ok !== true) {
    const detail = result.stderr ? ` (${String(result.stderr).slice(0, 300)})` : ''
    logTo(state.ctx, 'warn', `toast.ps1 reported an error${detail}`)
    return { shown: false, reason: isRecord(json) && json.error ? String(json.error) : 'error' }
  }
  if (json.shown === false) {
    const reason = typeof json.reason === 'string' ? json.reason : 'skipped'
    if (reason !== 'foreground') logTo(state.ctx, 'warn', `toast.ps1 skipped the notification: ${reason}`)
    return { shown: false, reason, foreground: json.foreground === true }
  }
  return { shown: true, reason: typeof json.reason === 'string' ? json.reason : 'shown', foreground: json.foreground === true }
}

/**
 * Read whether the DeepSeek Harness window is foreground through
 * `toast.ps1 -CheckOnly`, cached for ~750 ms.
 * @returns `{foreground:boolean}` or `null` when the check is unknown/failed.
 */
async function checkForeground(state) {
  const now = __internals.now()
  if (state.foregroundCache && now - state.foregroundCache.at < FOREGROUND_TTL_MS) {
    return state.foregroundCache.value
  }
  const result = await runPowerShell(state, 'toast.ps1', ['-CheckOnly'], CHECK_TIMEOUT_MS)
  let value = null
  if (result.ok && isRecord(result.json) && result.json.ok === true && typeof result.json.foreground === 'boolean') {
    value = { foreground: result.json.foreground }
  } else {
    logTo(state.ctx, 'warn', `foreground check failed: ${result.error || 'invalid JSON'}`)
  }
  state.foregroundCache = { at: __internals.now(), value }
  return value
}

// ---------------------------------------------------------------------------
// Protocol handler registration
// ---------------------------------------------------------------------------

/** Best-effort DeepSeek Harness executable for the handler's "app not running" path. */
function detectLaunchTarget() {
  try {
    const executable = process.execPath
    if (typeof executable !== 'string' || !/\.exe$/i.test(executable)) return undefined
    const base = basename(executable).toLowerCase()
    if (base === 'node.exe' || base === 'electron.exe' || base === 'node') return undefined
    return executable
  } catch {
    return undefined
  }
}

/** Register the `dsh-notify:` protocol handler once per process (fire and forget). */
async function registerProtocol(state) {
  if (state.protocolRegistered || state.protocolInFlight || state.disposed) return
  state.protocolInFlight = true
  try {
    const handlerPath = join(PLUGIN_DIR, 'notify-handler.ps1')
    const args = ['-HandlerPath', handlerPath]
    const launchTarget = detectLaunchTarget()
    if (launchTarget) args.push('-LaunchTarget', launchTarget)
    const result = await runPowerShell(state, 'setup-protocol.ps1', args, SETUP_TIMEOUT_MS)
    const confirmed = result.ok && isRecord(result.json) && result.json.ok === true && result.json.registered === true
    if (!result.ok) {
      logTo(state.ctx, 'warn', `setup-protocol.ps1 failed: ${result.error || 'unknown error'}`)
    } else if (!isRecord(result.json) || result.json.ok !== true) {
      logTo(state.ctx, 'warn', 'setup-protocol.ps1 did not confirm protocol registration')
    } else if (result.json.registered !== true) {
      logTo(state.ctx, 'warn', 'dsh-notify: protocol handler is not registered')
    } else {
      logTo(state.ctx, 'info', 'dsh-notify: protocol handler registered')
    }
    // Retry on a later settings change only when the registration was not confirmed.
    state.protocolRegistered = confirmed
  } catch (error) {
    logTo(state.ctx, 'warn', 'setup-protocol.ps1 failed unexpectedly', error)
  } finally {
    state.protocolInFlight = false
  }
}

// ---------------------------------------------------------------------------
// Local HTTP bridge
// ---------------------------------------------------------------------------

/** Whether an `Origin` header is allowed to use the local `/ui/*` surface. */
function isAllowedUiOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false
  return UI_HTTP_ORIGIN_PATTERN.test(origin) || UI_APP_ORIGIN_PATTERN.test(origin)
}

/** CORS response headers for one `/ui/*` request (none without an allowed Origin). */
function uiCorsHeaders(origin) {
  return isAllowedUiOrigin(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}
}

/** Whether the socket peer is loopback: the /ui surface is never exposed remotely. */
function isLoopbackRequest(request) {
  let address = ''
  try {
    address =
      (request.socket && request.socket.remoteAddress) ||
      (request.connection && request.connection.remoteAddress) ||
      ''
  } catch {
    address = ''
  }
  try {
    return Boolean(__internals.isLoopbackPeer(address))
  } catch {
    return false
  }
}

/** Fixed-window per-route rate limiter for the `/ui/*` control surface. */
function uiRateLimitOk(state, route) {
  const now = __internals.now()
  if (!state.uiRate) state.uiRate = new Map()
  const windowStart = now - UI_RATE_LIMIT.windowMs
  const recent = (state.uiRate.get(route) || []).filter((timestamp) => timestamp > windowStart)
  if (recent.length >= UI_RATE_LIMIT.max) {
    state.uiRate.set(route, recent)
    return { allowed: false, retryAfterMs: Math.max(0, recent[0] + UI_RATE_LIMIT.windowMs - now) }
  }
  recent.push(now)
  state.uiRate.set(route, recent)
  return { allowed: true, retryAfterMs: 0 }
}

/** Uniform `{ok,posted,reason}` response body for an immediate toast request. */
function toastResultPayload(shown) {
  const posted = Boolean(shown && shown.shown === true)
  const reason =
    shown && typeof shown.reason === 'string' && shown.reason.length > 0 ? shown.reason : posted ? 'shown' : 'not-shown'
  return { ok: true, posted, reason }
}

/** `/ui/health` payload: resolved config + diagnostics for remote curl checks. */
function buildUiHealth(state, port) {
  const cfg = state.config
  const startedAt = Number.isFinite(state.startedAt) ? state.startedAt : __internals.now()
  return {
    ok: true,
    app: 'dsh-windows-notification',
    version: PLUGIN_VERSION,
    uiPort: port,
    bridgePort: port,
    enabled: Boolean(cfg.enabled),
    config: { ...cfg },
    pendingApprovals: state.pendingApprovals.size,
    pendingQuestions: state.pendingQuestions.size,
    lastApplyAt: Number.isFinite(state.lastApplyAt) ? state.lastApplyAt : 0,
    uptimeMs: Math.max(0, __internals.now() - startedAt),
  }
}

/**
 * Loopback bridge receiving `POST /action {token, action, sessionId, approvalId}`
 * from notify-handler.ps1, and the unauthenticated (loopback-only) `/ui/*`
 * control surface used by the local DSH web page for instant test/demo toasts
 * plus health diagnostics. Owns `%LOCALAPPDATA%\dsh-windows-notification\bridge.json`.
 */
class LocalBridge {
  constructor(state) {
    this.state = state
    this.server = null
    this.token = null
    this.port = null
    this.uiPort = null
    this.listening = false
    this.starting = null
    this.bridgeFile = join(__internals.localAppDataDir(), 'bridge.json')
  }

  /** Start listening on the first free deterministic loopback UI port. */
  async start() {
    if (this.listening) return true
    if (this.starting) return this.starting
    if (this.state.disposed) return false
    this.starting = this.#start()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  async #start() {
    const token = randomBytes(32).toString('hex')
    let bound = null
    const candidates = Array.isArray(__internals.uiPortCandidates) ? __internals.uiPortCandidates : UI_PORT_CANDIDATES
    for (const candidate of [...candidates, 0]) {
      bound = await this.#listenOn(candidate)
      if (bound || this.state.disposed) break
    }
    if (!bound || this.state.disposed) {
      if (bound) {
        try {
          bound.server.close()
        } catch {
          /* ignore */
        }
      }
      logTo(this.state.ctx, 'warn', 'notification bridge failed to listen on loopback')
      return false
    }
    this.server = bound.server
    this.token = token
    this.port = bound.port
    this.uiPort = bound.port
    this.listening = true
    this.#writeBridgeFile()
    if (candidates.includes(bound.port)) {
      logTo(this.state.ctx, 'info', `notification bridge on 127.0.0.1:${bound.port} (deterministic ui port)`)
    } else {
      logTo(this.state.ctx, 'info', `notification bridge on 127.0.0.1:${bound.port} (ui port range busy/unavailable; ephemeral fallback)`)
    }
    return true
  }

  /** Try one loopback listen attempt; resolves null when the port is unavailable. */
  #listenOn(port) {
    return new Promise((resolve) => {
      let server = null
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        server = createServer((request, response) => {
          this.#handle(request, response).catch(() => {
            try {
              response.destroy()
            } catch {
              /* ignore */
            }
          })
        })
        server.on('clientError', (_error, socket) => {
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
        })
        server.once('error', () => {
          try {
            server.close()
          } catch {
            /* ignore */
          }
          finish(null)
        })
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          const actualPort = address && typeof address === 'object' ? Number(address.port) : 0
          if (!Number.isInteger(actualPort) || actualPort <= 0) {
            try {
              server.close()
            } catch {
              /* ignore */
            }
            finish(null)
            return
          }
          finish({ server, port: actualPort })
        })
      } catch (error) {
        try {
          server?.close()
        } catch {
          /* ignore */
        }
        logTo(this.state.ctx, 'warn', 'notification bridge could not be created', error)
        finish(null)
      }
    })
  }

  /** Write bridge.json atomically (tmp + rename). Never throws. */
  #writeBridgeFile() {
    try {
      mkdirSync(dirname(this.bridgeFile), { recursive: true })
      const temporary = `${this.bridgeFile}.${process.pid}.tmp`
      const payload = JSON.stringify({
        port: this.port,
        uiPort: this.uiPort,
        token: this.token,
        pid: process.pid,
        updatedAt: __internals.now(),
      })
      writeFileSync(temporary, payload, 'utf8')
      renameSync(temporary, this.bridgeFile)
    } catch (error) {
      logTo(this.state.ctx, 'warn', 'could not write notification bridge.json (toast actions may not work)', error)
    }
  }

  /** Remove our own bridge.json (never a stale file another process owns). */
  #deleteBridgeFile() {
    try {
      const parsed = JSON.parse(readFileSync(this.bridgeFile, 'utf8'))
      if (isRecord(parsed) && parsed.pid === process.pid) rmSync(this.bridgeFile, { force: true })
    } catch {
      /* missing / unreadable / foreign file: leave it alone */
    }
  }

  /** Write one JSON (or empty) response with optional extra headers. */
  #respond(response, status, payload, extraHeaders) {
    try {
      const headers = { 'cache-control': 'no-store', ...(extraHeaders || {}) }
      if (status === 204 || payload === undefined) {
        response.writeHead(status, headers)
        response.end()
        return
      }
      const body = JSON.stringify(payload)
      headers['content-type'] = 'application/json; charset=utf-8'
      headers['content-length'] = Buffer.byteLength(body)
      response.writeHead(status, headers)
      response.end(body)
    } catch {
      try {
        response.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  /** Handle one bridge HTTP request (legacy /action + the /ui control surface). */
  async #handle(request, response) {
    const rawUrl = typeof request.url === 'string' ? request.url : ''
    const path = rawUrl.split('?')[0]
    if (path === '/ui/health' || path === '/ui/test' || path === '/ui/demo') {
      await this.#handleUi(request, response, path)
      return
    }
    // Legacy handler-click endpoint: unchanged token-guarded POST /action.
    if (request.method !== 'POST' || request.url !== '/action') {
      this.#respond(response, 404, { ok: false, error: 'not-found' })
      return
    }
    const raw = await readRequestBody(request, MAX_BODY_BYTES)
    if (raw === null) {
      this.#respond(response, 413, { ok: false, error: 'body-too-large' })
      return
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      this.#respond(response, 400, { ok: false, error: 'invalid-json' })
      return
    }
    if (!isRecord(payload)) {
      this.#respond(response, 400, { ok: false, error: 'invalid-payload' })
      return
    }
    if (!tokensEqual(payload.token, this.token)) {
      this.#respond(response, 401, { ok: false, error: 'unauthorized' })
      return
    }
    const action = payload.action
    if (action !== 'open' && action !== 'approve' && action !== 'deny' && action !== 'answer' && action !== 'demo') {
      this.#respond(response, 400, { ok: false, error: 'unknown-action' })
      return
    }
    const result = resolveBridgeAction(this.state, action, payload)
    this.#respond(response, result.ok ? 200 : 404, result)
  }

  /**
   * `/ui/*` control surface for the local DSH web page and desktop renderer:
   * no bridge token, but loopback-peer only, Origin-allowlisted (loopback
   * http(s) and the desktop's `dsh-app://` scheme), rate limited and 4 KB body
   * capped. Bodies may be JSON or the `no-cors` `text/plain` fallback.
   */
  async #handleUi(request, response, path) {
    const origin =
      request.headers && typeof request.headers.origin === 'string' && request.headers.origin.length > 0
        ? request.headers.origin
        : ''
    const cors = uiCorsHeaders(origin)
    if (origin && !isAllowedUiOrigin(origin)) {
      this.#respond(response, 403, { ok: false, error: 'origin-not-allowed' })
      return
    }
    if (!isLoopbackRequest(request)) {
      this.#respond(response, 403, { ok: false, error: 'loopback-only' })
      return
    }
    if (request.method === 'OPTIONS') {
      this.#respond(response, 204, undefined, {
        ...cors,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      })
      return
    }
    if (path === '/ui/health') {
      if (request.method !== 'GET') {
        this.#respond(response, 405, { ok: false, error: 'method-not-allowed' }, cors)
        return
      }
      this.#respond(response, 200, buildUiHealth(this.state, this.port), cors)
      return
    }
    if (request.method !== 'POST') {
      this.#respond(response, 405, { ok: false, error: 'method-not-allowed' }, cors)
      return
    }
    const rawBody = await readRequestBody(request, MAX_BODY_BYTES)
    if (rawBody === null) {
      this.#respond(response, 413, { ok: false, error: 'body-too-large' }, cors)
      return
    }
    // Body parsing: JSON normally, plus the `no-cors` simple-request fallback
    // (`content-type: text/plain`) the desktop renderer may use. Empty bodies are
    // fine (both endpoints have defaults); unparseable text/plain bodies are
    // ignored, other content types must be valid JSON.
    const contentType =
      request.headers && typeof request.headers['content-type'] === 'string'
        ? request.headers['content-type'].toLowerCase()
        : ''
    const simpleRequestBody = contentType.startsWith('text/plain')
    let payload = {}
    if (rawBody.trim().length > 0) {
      let parsed = false
      try {
        payload = JSON.parse(rawBody)
        parsed = true
      } catch {
        parsed = false
      }
      if (!parsed || !isRecord(payload)) {
        if (!simpleRequestBody) {
          this.#respond(
            response,
            400,
            { ok: false, error: parsed ? 'invalid-payload' : 'invalid-json' },
            cors,
          )
          return
        }
        payload = {}
      }
    }
    const limited = uiRateLimitOk(this.state, path)
    if (!limited.allowed) {
      const retryAfterMs = Math.max(1, Math.ceil(limited.retryAfterMs))
      this.#respond(
        response,
        429,
        { ok: false, error: 'rate-limited', retryAfterMs },
        { ...cors, 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
      )
      return
    }
    const cfg = this.state.config
    if (path === '/ui/test') {
      const shown = await postConfirmationToast(this.state, cfg, '测试通知', '通知测试成功，一切正常。', `ui-test-${__internals.now()}`)
      this.#respond(response, 200, toastResultPayload(shown), cors)
      return
    }
    const explicitKind = typeof payload.kind === 'string' && payload.kind.length > 0 ? payload.kind : ''
    const demoKind = explicitKind || cfg.demoKind
    if (!DEMO_KINDS.includes(demoKind)) {
      this.#respond(response, 400, { ok: false, error: 'invalid-kind', kinds: [...DEMO_KINDS] }, cors)
      return
    }
    const shown = await postDemoToast(this.state, cfg, demoKind)
    this.#respond(response, 200, { ...toastResultPayload(shown), kind: demoKind }, cors)
  }

  /** Close the server and delete our bridge.json. Never throws. */
  async dispose() {
    this.listening = false
    this.token = null
    const server = this.server
    this.server = null
    if (server) {
      await new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          server.close(() => done())
        } catch {
          done()
        }
        const guard = setTimeout(done, 1000)
        if (typeof guard.unref === 'function') guard.unref()
      })
    }
    this.#deleteBridgeFile()
  }
}

/** Read exactly one request body, capped. Resolves null when the cap is exceeded. */
function readRequestBody(request, limit) {
  return new Promise((resolve) => {
    let total = 0
    const chunks = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        finish(null)
        try {
          request.resume() // drain the rest so the 413 response can still be written
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => finish(null))
  })
}

// ---------------------------------------------------------------------------
// Bridge action resolution (approvals / user questions / demos / open)
// ---------------------------------------------------------------------------

/** Non-empty string helper for untrusted bridge payload fields. */
function payloadString(value) {
  return typeof value === 'string' ? value : ''
}

/** Human/confirmation text for one demo activation (no real approval/question exists). */
function describeDemoOutcome(payload) {
  const kind = payloadString(payload.kind)
  const choice = payloadString(payload.choice) || payloadString(payload.decision)
  const text = payloadString(payload.text).trim()
  if (kind === 'approval') {
    const denied = choice === 'deny' || choice === 'reject' || choice === 'rejected'
    return {
      title: '演示成功',
      body: denied ? '演示成功：你选择了「拒绝」。' : '演示成功：你选择了「允许一次」。',
    }
  }
  if (kind === 'question-options') {
    const labels = ['方案 A', '方案 B', '稍后处理']
    const index = Number.parseInt(choice, 10)
    const label = Number.isInteger(index) && index >= 0 && index < labels.length ? labels[index] : choice || '未知选项'
    return { title: '演示成功', body: `演示成功：你选择了「${clip(label, 40)}」。` }
  }
  if (kind === 'question-text') {
    return {
      title: '演示成功',
      body: text ? `演示成功：收到你的输入「${clip(text, 60)}」。` : '演示成功：文字演示通知的点击已被处理。',
    }
  }
  return { title: '演示成功', body: '演示成功：演示通知已被点击。' }
}

/** Post the follow-up confirmation for one demo activation (never throws). */
function postDemoResultToast(state, payload) {
  try {
    const cfg = state.config
    const { title, body } = describeDemoOutcome(payload)
    const xml = buildDemoResultToastXml({ cfg, title, body })
    void enqueueToast(state, {
      xml,
      tag: toastTag('demo-result', String(__internals.now())),
      skipWhenForeground: false,
    }).catch((error) => {
      logTo(state.ctx, 'warn', 'demo confirmation toast failed', error)
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'demo confirmation failed', error)
  }
}

/** Apply one authenticated bridge action to the pending maps / demo path. */
function resolveBridgeAction(state, action, payload) {
  const sessionId = payloadString(payload.sessionId)
  if (action === 'open') {
    // A question toast's "打开 DSH" carries its token so the claim can be released
    // immediately; notify-handler.ps1 has already focused the harness window.
    const questionId = payloadString(payload.questionId)
    if (questionId) {
      const pending = state.pendingQuestions.get(questionId)
      if (pending) {
        if (sessionId && pending.sessionId && sessionId !== pending.sessionId) {
          return { ok: false, error: 'session-mismatch' }
        }
        state.pendingQuestions.delete(questionId)
        pending.release()
        pending.settle('open')
        return { ok: true, action: 'open', questionId }
      }
    }
    logTo(state.ctx, 'info', 'notification action: open DeepSeek Harness')
    return { ok: true, action: 'open' }
  }
  if (action === 'demo') {
    postDemoResultToast(state, payload)
    return { ok: true, action: 'demo', kind: payloadString(payload.kind) }
  }
  if (action === 'answer') {
    const questionId = payloadString(payload.questionId)
    if (!questionId) return { ok: false, error: 'unknown-question' }
    const pending = state.pendingQuestions.get(questionId)
    if (!pending) return { ok: false, error: 'unknown-question' }
    if (sessionId && pending.sessionId && sessionId !== pending.sessionId) {
      return { ok: false, error: 'session-mismatch' }
    }
    if (pending.mode === 'text') {
      const text = payloadString(payload.text).trim()
      state.pendingQuestions.delete(questionId)
      pending.release()
      // Empty submit is treated like a timeout: fall back to the in-app question UI.
      if (!text) {
        pending.settle('fallback')
        return { ok: true, action: 'answer', questionId, empty: true }
      }
      pending.settle({ kind: 'text', text })
      return { ok: true, action: 'answer', questionId }
    }
    const index = Number.parseInt(payloadString(payload.choice), 10)
    const labels = pending.optionLabels || []
    if (!Number.isInteger(index) || index < 0 || index >= labels.length) {
      return { ok: false, error: 'invalid-choice' }
    }
    state.pendingQuestions.delete(questionId)
    pending.release()
    pending.settle({ kind: 'option', label: labels[index] })
    return { ok: true, action: 'answer', questionId, choice: String(index) }
  }
  const approvalId = payloadString(payload.approvalId)
  if (!approvalId) return { ok: false, error: 'unknown-approval' }
  const pending = state.pendingApprovals.get(approvalId)
  if (!pending) return { ok: false, error: 'unknown-approval' }
  if (sessionId && pending.sessionId && sessionId !== pending.sessionId) {
    return { ok: false, error: 'session-mismatch' }
  }
  state.pendingApprovals.delete(approvalId)
  pending.release()
  pending.settle(action === 'approve' ? 'allowed' : 'rejected')
  return { ok: true, action, approvalId }
}

// ---------------------------------------------------------------------------
// Settings reconciliation
// ---------------------------------------------------------------------------

/** Read the currently authoritative settings value (settings scope or row config). */
function readSettings(state) {
  try {
    const source = state.source
    if (typeof source === 'function') return normalizeSettings(source())
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not read windows-notification settings; using launch config', error)
  }
  return normalizeSettings(state.entry)
}

/** Ensure the bridge (and, once listening, the protocol handler) exists while enabled. */
function reconcileRuntime(state) {
  if (state.disposed) return
  if (!state.config.enabled) {
    state.foregroundCache = null
    releasePendingApprovals(state, 'timeout')
    releasePendingQuestions(state, 'released')
    return
  }
  void ensureBridge(state)
    .then((ready) => {
      if (!ready || state.disposed || !state.config.enabled) return undefined
      return registerProtocol(state)
    })
    .catch((error) => {
      logTo(state.ctx, 'warn', 'notification runtime setup failed', error)
    })
}

/** Start the loopback bridge lazily, once. */
async function ensureBridge(state) {
  if (state.disposed) return false
  if (!state.bridge) state.bridge = new LocalBridge(state)
  try {
    const ready = await state.bridge.start()
    if (!ready) {
      logTo(state.ctx, 'warn', 'notification bridge unavailable; approvals fall back to the in-app prompt')
    }
    return ready
  } catch (error) {
    logTo(state.ctx, 'warn', 'notification bridge failed to start', error)
    return false
  }
}

/** Release every pending approval with one outcome (fallback path). */
function releasePendingApprovals(state, outcome) {
  for (const [approvalId, entry] of [...state.pendingApprovals]) {
    state.pendingApprovals.delete(approvalId)
    entry.release()
    try {
      entry.settle(outcome)
    } catch {
      /* ignored */
    }
  }
}

/**
 * Release every pending question claim; the listener continuation then calls
 * `next()` so the in-app question UI becomes the answerer (contract v1.1).
 */
function releasePendingQuestions(state, outcome = 'released') {
  for (const [questionId, entry] of [...state.pendingQuestions]) {
    state.pendingQuestions.delete(questionId)
    entry.release()
    try {
      entry.settle(outcome)
    } catch {
      /* ignored */
    }
  }
}

// ---------------------------------------------------------------------------
// v1.3 — re-apply-safe ping triggers (desktop runtime edits re-apply the plugin)
// ---------------------------------------------------------------------------

/** Path of the persisted ping-trigger baseline. */
function pingStatePath() {
  return join(__internals.localAppDataDir(), 'state.json')
}

/** Read (and cache) the persisted ping-trigger baseline; null when absent/invalid. */
function readPingState(state) {
  if (state.pingStateLoaded) return state.pingState
  state.pingStateLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(pingStatePath(), 'utf8'))
    if (isRecord(parsed)) {
      state.pingState = {
        testPing: clampInt(parsed.testPing, 0, Number.MAX_SAFE_INTEGER, 0),
        demoPing: clampInt(parsed.demoPing, 0, Number.MAX_SAFE_INTEGER, 0),
      }
    }
  } catch {
    state.pingState = null
  }
  return state.pingState
}

/** Persist the ping-trigger baseline atomically (tmp + rename). Never throws. */
function writePingState(state, cfg) {
  const payload = { testPing: cfg.testPing, demoPing: cfg.demoPing }
  state.pingState = payload
  state.pingStateLoaded = true
  try {
    mkdirSync(dirname(pingStatePath()), { recursive: true })
    const temporary = `${pingStatePath()}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(payload), 'utf8')
    renameSync(temporary, pingStatePath())
  } catch (error) {
    if (!state.pingStateWarned) {
      state.pingStateWarned = true
      logTo(state.ctx, 'warn', 'could not persist the notification ping state', error)
    }
  }
}

/** Seed the baseline without firing (first apply / settings attach). */
function seedPingState(state, cfg) {
  writePingState(state, cfg)
}

/**
 * Compare the current config against the persisted baseline, persist it, and
 * report which write-only triggers changed. First-ever apply seeds without
 * firing. Shared by the desktop re-apply path and the old-runtime onChange path.
 */
function runPingTriggers(state, cfg) {
  const previous = readPingState(state)
  if (!previous) {
    seedPingState(state, cfg)
    return { seeded: true, testPing: false, demoPing: false }
  }
  const changed = {
    seeded: false,
    testPing: cfg.testPing !== previous.testPing,
    demoPing: cfg.demoPing !== previous.demoPing,
  }
  if (changed.testPing || changed.demoPing) writePingState(state, cfg)
  return changed
}

/** Fire the test/demo toasts for one set of changed triggers. */
function firePingTriggers(state, cfg, triggers) {
  try {
    if (!cfg.enabled) return
    if (triggers.testPing) {
      postConfirmationToast(state, cfg, '测试通知', '通知测试成功，一切正常。', 'test-ping')
    }
    if (triggers.demoPing) {
      postDemoToast(state, cfg)
    }
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not post a ping-trigger toast', error)
  }
}

/** Settings changed: recompute config, react to testPing / demoPing / enable edges. */
function onSettingsChange(state) {
  if (state.disposed) return
  let next
  try {
    next = readSettings(state)
  } catch (error) {
    logTo(state.ctx, 'warn', 'windows-notification settings change could not be applied', error)
    return
  }
  const previous = state.config
  if (!state.bootstrapped) {
    // First observation of the settings scope: adopt it silently (no boot toast)
    // and move the persisted ping baseline onto these resolved values.
    state.bootstrapped = true
    state.config = next
    try {
      seedPingState(state, next)
    } catch {
      /* baseline persistence is best effort */
    }
    reconcileRuntime(state)
    return
  }
  state.config = next
  try {
    const triggers = runPingTriggers(state, next)
    firePingTriggers(state, next, triggers)
    if (next.enabled && !previous.enabled) {
      postConfirmationToast(state, next, 'Windows 通知已连接', '任务完成、会话出错或需要审批时，会在这里提醒你。', 'connected')
    }
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not post the settings confirmation toast', error)
  }
  reconcileRuntime(state)
}

/**
 * Post one demo notification for the current (or an explicit) `demoKind`
 * (never foreground-suppressed). Resolves with the display result so the
 * /ui/demo channel can report `posted`.
 */
function postDemoToast(state, cfg, demoKindOverride) {
  try {
    const demoKind = DEMO_KINDS.includes(demoKindOverride) ? demoKindOverride : cfg.demoKind
    const xml = buildDemoToastXml({ cfg, demoKind })
    return enqueueToast(state, {
      xml,
      tag: toastTag('demo', `${demoKind}-${__internals.now()}`),
      skipWhenForeground: false,
    }).catch((error) => {
      logTo(state.ctx, 'warn', 'demo toast failed', error)
      return { shown: false, reason: 'error' }
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'demo toast could not be built', error)
    return Promise.resolve({ shown: false, reason: 'error' })
  }
}

/**
 * Post one fixed confirmation toast (never suppressed by the foreground check).
 * Resolves with the display result so /ui/test can report `posted`.
 */
function postConfirmationToast(state, cfg, title, body, tagDetail) {
  try {
    const xml = buildConfirmationToastXml({ cfg, title, body })
    return enqueueToast(state, {
      xml,
      tag: toastTag(tagDetail, String(__internals.now())),
      skipWhenForeground: false,
    }).catch((error) => {
      logTo(state.ctx, 'warn', 'confirmation toast failed', error)
      return { shown: false, reason: 'error' }
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'confirmation toast could not be built', error)
    return Promise.resolve({ shown: false, reason: 'error' })
  }
}

// ---------------------------------------------------------------------------
// Session event handling
// ---------------------------------------------------------------------------

/** Session id as a plain string (empty when unavailable). */
function sessionKeyOf(session) {
  try {
    const id = session && session.id
    if (typeof id === 'string' && id.length > 0) return id
    if (id !== undefined && id !== null) return String(id)
  } catch {
    /* ignore */
  }
  return ''
}

/** Session header metadata (`session.header`, defensively `session.meta`). */
function sessionMetaOf(session) {
  try {
    if (session && isRecord(session.header)) return session.header
    if (session && isRecord(session.meta)) return session.meta
  } catch {
    /* ignore */
  }
  return {}
}

/** Whether a session is a subagent child session (skip its notifications). */
function isSubagentSession(session) {
  const meta = sessionMetaOf(session)
  if (meta.origin === 'subagent') return true
  const depth = Number(meta.delegationDepth)
  return Number.isFinite(depth) && depth > 0
}

/** Human-readable error text from a `TurnEndReason.error` failure. */
function turnErrorText(reason) {
  const failure = reason && reason.error
  if (!failure) return '未知错误'
  if (typeof failure === 'string') return failure
  if (isRecord(failure) && typeof failure.message === 'string' && failure.message.trim().length > 0) {
    return failure.message.trim()
  }
  try {
    return JSON.stringify(failure)
  } catch {
    return '未知错误'
  }
}

/** Extract plain text from an assistant message's content blocks. */
function assistantMessageText(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text.trim()
}

/** Remember the latest assistant text per session for the completion preview. */
function rememberAssistantText(state, session, event) {
  const key = sessionKeyOf(session)
  if (!key) return
  const content = event && event.data && event.data.message && event.data.message.content
  const text = assistantMessageText(content)
  if (!text) return
  state.lastAssistant.set(key, text)
  if (state.lastAssistant.size > 60) {
    const oldest = state.lastAssistant.keys().next().value
    if (oldest !== undefined) state.lastAssistant.delete(oldest)
  }
}

/** Session title through the optional `sessionTitle` service (fallback: empty). */
function sessionTitleOf(state, session) {
  try {
    const service = state.ctx && typeof state.ctx.get === 'function' ? state.ctx.get('sessionTitle') : undefined
    if (!service || typeof service.get !== 'function') return ''
    const snapshot = service.get(session)
    if (isRecord(snapshot) && typeof snapshot.title === 'string') return snapshot.title.trim()
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not read the session title', error)
  }
  return ''
}

// ---------------------------------------------------------------------------
// v1.2 — per-turn telemetry (turn/start -> step/end -> tool/call -> turn/end)
// ---------------------------------------------------------------------------

/** Start a fresh current-turn telemetry record at `turn/start`. */
function resetTurnTelemetry(state, session, event) {
  const key = sessionKeyOf(session)
  if (!key) return
  const data = isRecord(event.data) ? event.data : {}
  const turn = Number(data.turn)
  const startedAt = Number.isFinite(Number(event.time)) ? Number(event.time) : __internals.now()
  state.turnStats.set(key, {
    turn: Number.isFinite(turn) ? turn : -1,
    startedAt,
    steps: 0,
    toolCalls: 0,
    toolNames: [],
  })
  if (state.turnStats.size > 200) {
    const oldest = state.turnStats.keys().next().value
    if (oldest !== undefined) state.turnStats.delete(oldest)
  }
}

/** Count one completed step on the session's current turn. */
function recordStepEndTelemetry(state, session) {
  const stats = state.turnStats.get(sessionKeyOf(session))
  if (stats) stats.steps += 1
}

/** Count one tool call and remember up to three distinct tool names for the turn. */
function recordToolCallTelemetry(state, session, event) {
  const stats = state.turnStats.get(sessionKeyOf(session))
  if (!stats) return
  stats.toolCalls += 1
  const name = isRecord(event.data) && typeof event.data.name === 'string' ? event.data.name : ''
  if (name && stats.toolNames.length < 3 && !stats.toolNames.includes(name)) stats.toolNames.push(name)
}

/** Take (and clear) the current-turn telemetry, adding the start → end duration. */
function takeTurnTelemetry(state, session, event) {
  const key = sessionKeyOf(session)
  if (!key) return null
  const stats = state.turnStats.get(key)
  if (!stats) return null
  state.turnStats.delete(key)
  const endTime = Number.isFinite(Number(event.time)) ? Number(event.time) : __internals.now()
  return { ...stats, durationMs: Math.max(0, endTime - stats.startedAt) }
}

/** Handle one `session/event` notification (sync; never throws). */
function handleSessionEvent(state, session, event) {
  try {
    if (state.disposed || !isRecord(event)) return
    const type = event.type
    if (type === 'assistant/message') {
      rememberAssistantText(state, session, event)
      return
    }
    if (type === 'turn/start') {
      const key = sessionKeyOf(session)
      if (key) state.lastAssistant.delete(key)
      resetTurnTelemetry(state, session, event)
      return
    }
    if (type === 'step/end') {
      recordStepEndTelemetry(state, session)
      return
    }
    if (type === 'tool/call') {
      recordToolCallTelemetry(state, session, event)
      return
    }
    if (type !== 'turn/end') return
    handleTurnEnd(state, session, event)
  } catch (error) {
    logTo(state.ctx, 'warn', 'session/event handler failed', error)
  }
}

/** Build + enqueue the turn-complete / turn-error toast (v1.2 smart content/tag/priority). */
function handleTurnEnd(state, session, event) {
  const data = isRecord(event.data) ? event.data : {}
  const reason = isRecord(data.reason) ? data.reason : {}
  const kind = reason.kind
  const cfg = state.config
  const key = sessionKeyOf(session)
  if (!key) return
  const turnValue = Number(data.turn)
  const turn = Number.isFinite(turnValue) ? turnValue : -1
  if (turn >= 0) {
    const lastNotified = state.lastTurn.get(key)
    if (typeof lastNotified === 'number' && lastNotified >= turn) return
    state.lastTurn.set(key, turn)
    if (state.lastTurn.size > 200) {
      const oldest = state.lastTurn.keys().next().value
      if (oldest !== undefined) state.lastTurn.delete(oldest)
    }
  }
  // Consume the current-turn telemetry even when this turn yields no toast.
  const telemetry = takeTurnTelemetry(state, session, event)
  if (!cfg.enabled) return
  if (kind === 'completed') {
    if (!cfg.onTurnComplete) return
  } else if (kind === 'error') {
    if (!cfg.onError) return
  } else {
    return // aborted / blocked / max-tokens / interrupted: no automatic toast
  }
  if (isSubagentSession(session)) return
  const preview = state.lastAssistant.get(key) || ''
  const title = sessionTitleOf(state, session)
  const summaryLine = cfg.smartSummary && telemetry ? turnSummaryLine(telemetry) : ''
  const errorCode =
    kind === 'error' && isRecord(reason.error) && typeof reason.error.code === 'string' ? reason.error.code : ''
  const xml = buildTurnEndToastXml({
    cfg,
    kind,
    sessionTitle: title,
    preview,
    errorMessage: kind === 'error' ? turnErrorText(reason) : '',
    errorCode,
    summaryLine,
    sessionId: key,
  })
  // v1.2 session collapse: one stable Tag per session replaces the previous
  // completion/error notification in Action Center; per-turn tags when off.
  const tag = cfg.sessionCollapse
    ? sessionCollapseTag(key)
    : toastTag(kind === 'completed' ? 'turn-done' : 'turn-error', `${key}-${turn}`)
  void enqueueToast(state, {
    xml,
    tag,
    skipWhenForeground: cfg.skipWhenForeground,
    ...(kind === 'error' ? { priority: 'high' } : {}),
  })
    .then((result) => {
      if (result.shown) logTo(state.ctx, 'info', `turn ${kind} toast shown for session ${key}`)
    })
    .catch((error) => {
      logTo(state.ctx, 'warn', 'turn toast failed', error)
    })
}

// ---------------------------------------------------------------------------
// Approval handling
// ---------------------------------------------------------------------------

/**
 * Prepended `approval/request` waterfall listener: while the harness window is
 * not foreground, claim the request with an actionable toast and answer from
 * the bridge decision / timeout / request abort. Otherwise delegate with next().
 */
async function onApprovalRequest(state, request, next) {
  try {
    const cfg = state.config
    if (state.disposed || !cfg.enabled || !cfg.onApproval || !cfg.approvalActions) return next()
    const bridge = state.bridge
    if (!bridge || !bridge.listening) return next()
    const foreground = await checkForeground(state)
    if (foreground === null || foreground.foreground) return next()
    const agent = isRecord(request && request.agent) ? request.agent : null
    const session = agent && isRecord(agent.session) ? agent.session : null
    const sessionId = sessionKeyOf(session) || (agent && typeof agent.id === 'string' ? agent.id : '')
    const toolName = request && typeof request.toolName === 'string' ? request.toolName : ''
    const reason = request && typeof request.reason === 'string' ? request.reason : ''
    const signal = request && request.signal && typeof request.signal === 'object' ? request.signal : null
    const outcome = await claimApproval(state, cfg, {
      approvalId: randomBytes(8).toString('hex'),
      sessionId,
      toolName,
      reason,
      signal,
    })
    if (outcome === 'allowed') return 'allowed-once'
    if (outcome === 'rejected') return 'rejected'
    if (outcome === 'cancelled') return 'cancelled'
    return next() // timeout / could not display: let the in-app prompt ask
  } catch (error) {
    logTo(state.ctx, 'warn', 'approval notification handler failed; falling back to the in-app prompt', error)
    try {
      return next()
    } catch {
      return 'unavailable'
    }
  }
}

/**
 * Claim one approval request: display the actionable toast, then await the
 * bridge decision / timeout / abort.
 * @returns `'allowed' | 'rejected' | 'cancelled' | 'timeout' | null`
 *   (`null` = could not display, caller must delegate to next()).
 */
async function claimApproval(state, cfg, info) {
  const { approvalId, sessionId, toolName, reason, signal } = info
  if (state.disposed) return null
  if (signal && signal.aborted) return null
  let settle
  const decision = new Promise((resolve) => {
    settle = resolve
  })
  const entry = {
    approvalId,
    sessionId,
    timer: null,
    detachAbort: null,
    settle: (outcome) => settle(outcome),
    release: () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      try {
        entry.detachAbort?.()
      } catch {
        /* ignore */
      }
      entry.detachAbort = null
    },
  }
  state.pendingApprovals.set(approvalId, entry)
  const onAbort = () => {
    if (!state.pendingApprovals.delete(approvalId)) return
    entry.release()
    settle('cancelled')
  }
  if (signal && typeof signal.addEventListener === 'function') {
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      entry.detachAbort = () => {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* non-standard signal: continue without abort wiring */
    }
  }
  const xml = buildApprovalToastXml({ cfg, toolName, reason, approvalId, sessionId })
  let shown = { shown: false, reason: 'not-attempted' }
  try {
    shown = await enqueueToast(state, {
      xml,
      tag: toastTag('approval', approvalId),
      skipWhenForeground: false,
      priority: 'high',
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'approval toast failed to display', error)
  }
  if (!shown.shown) {
    state.pendingApprovals.delete(approvalId)
    entry.release()
    return null
  }
  const timeoutMs = Math.max(1000, Math.min(300, cfg.approvalTimeoutSec) * 1000)
  entry.timer = setTimeout(() => {
    if (!state.pendingApprovals.delete(approvalId)) return
    entry.release()
    settle('timeout')
  }, timeoutMs)
  if (typeof entry.timer.unref === 'function') entry.timer.unref()
  try {
    return await decision
  } catch {
    return 'timeout'
  } finally {
    state.pendingApprovals.delete(approvalId)
    entry.release()
  }
}

// ---------------------------------------------------------------------------
// v1.1 — user question handling (`user-questions/request`)
// ---------------------------------------------------------------------------

/** Normalize the untrusted `user-questions/request.questions` payload. */
function normalizeQuestionItems(input) {
  if (!Array.isArray(input)) return []
  const questions = []
  for (const item of input) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id : item.id === undefined || item.id === null ? '' : String(item.id)
    if (!id) continue
    const options = []
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (isRecord(option) && typeof option.label === 'string' && option.label.length > 0) {
          options.push({ label: option.label })
        }
      }
    }
    questions.push({
      id,
      question: typeof item.question === 'string' ? item.question : '',
      detail: typeof item.detail === 'string' ? item.detail : '',
      header: typeof item.header === 'string' ? item.header : '',
      options,
      multiSelect: item.multiSelect === true,
    })
  }
  return questions
}

/** Session id of the asking agent (`agent.session?.id` or, in production, `agent.id`). */
function questionSessionIdOf(request) {
  const agent = request && isRecord(request.agent) ? request.agent : null
  if (!agent) return ''
  const session = isRecord(agent.session) ? agent.session : null
  const fromSession = sessionKeyOf(session)
  if (fromSession) return fromSession
  return typeof agent.id === 'string' ? agent.id : ''
}

/** Notify-only question toast (multi-question / multi-select): never claimed. */
function postQuestionNoticeToast(state, cfg, questions, sessionId) {
  try {
    const xml = buildQuestionNoticeToastXml({ cfg, questions, sessionId })
    void enqueueToast(state, {
      xml,
      tag: toastTag('question-notice', String(__internals.now())),
      skipWhenForeground: cfg.skipWhenForeground,
      priority: 'high',
    }).catch((error) => {
      logTo(state.ctx, 'warn', 'question notice toast failed', error)
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'question notice toast could not be built', error)
  }
}

/**
 * Prepended `user-questions/request` waterfall listener (v1.1): claim one
 * single-select question with option buttons (or a text input) while the
 * harness window is not foreground; otherwise notify-only and delegate.
 */
async function onUserQuestionRequest(state, request, next) {
  try {
    const cfg = state.config
    if (state.disposed || !cfg.enabled || !cfg.onUserQuestion) return next()
    const questions = normalizeQuestionItems(request && request.questions)
    if (questions.length === 0) return next()
    const bridge = state.bridge
    if (!bridge || !bridge.listening) return next()
    const question = questions.length === 1 ? questions[0] : null
    const claimable = Boolean(question) && cfg.questionActions && question.multiSelect !== true
    if (!claimable) {
      // Multi-question / multi-select: notify only, never claim.
      postQuestionNoticeToast(state, cfg, questions, questionSessionIdOf(request))
      return next()
    }
    const foreground = await checkForeground(state)
    if (foreground === null || foreground.foreground) return next()
    const outcome = await claimQuestion(state, cfg, {
      question,
      sessionId: questionSessionIdOf(request),
      signal: request && request.signal && typeof request.signal === 'object' ? request.signal : null,
    })
    if (!outcome || (outcome.kind !== 'option' && outcome.kind !== 'text')) return next()
    const answerItem = { id: question.id, selected: outcome.kind === 'option' ? [outcome.label] : [] }
    if (outcome.kind === 'text') answerItem.custom = outcome.text
    return { answers: [answerItem] }
  } catch (error) {
    logTo(state.ctx, 'warn', 'user-question notification handler failed; falling back to the in-app question UI', error)
    try {
      return next()
    } catch {
      return undefined
    }
  }
}

/**
 * Claim one single-select question: display the option/text toast, then await
 * the bridge answer / open / timeout / request abort.
 * @returns `{kind:'option',label}` | `{kind:'text',text}` | `null` (delegate).
 */
async function claimQuestion(state, cfg, info) {
  const { question, sessionId, signal } = info
  if (state.disposed || !question) return null
  if (signal && signal.aborted) return null
  const dedupeKey = `${sessionId}:${question.id}`
  for (const pending of state.pendingQuestions.values()) {
    if (pending.dedupeKey === dedupeKey) return null
  }
  const questionId = randomBytes(8).toString('hex')
  const mode = question.options.length > 0 ? 'options' : 'text'
  let settle
  const outcome = new Promise((resolve) => {
    settle = resolve
  })
  const entry = {
    questionId,
    sessionId,
    mode,
    dedupeKey,
    optionLabels: question.options.slice(0, 3).map((option) => option.label),
    timer: null,
    detachAbort: null,
    settle: (value) => settle(value),
    release: () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      try {
        entry.detachAbort?.()
      } catch {
        /* ignore */
      }
      entry.detachAbort = null
    },
  }
  state.pendingQuestions.set(questionId, entry)
  const onAbort = () => {
    if (!state.pendingQuestions.delete(questionId)) return
    entry.release()
    settle('aborted')
  }
  if (signal && typeof signal.addEventListener === 'function') {
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      entry.detachAbort = () => {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* non-standard signal: continue without abort wiring */
    }
  }
  const xml =
    mode === 'options'
      ? buildQuestionOptionsToastXml({ cfg, question, questionToken: questionId, sessionId })
      : buildQuestionTextToastXml({ cfg, question, questionToken: questionId, sessionId })
  let shown = { shown: false, reason: 'not-attempted' }
  try {
    shown = await enqueueToast(state, {
      xml,
      tag: toastTag('question', questionId),
      skipWhenForeground: false,
      priority: 'high',
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'question toast failed to display', error)
  }
  if (!shown.shown) {
    state.pendingQuestions.delete(questionId)
    entry.release()
    return null
  }
  const timeoutMs = Math.max(1000, Math.min(600, cfg.questionTimeoutSec) * 1000)
  entry.timer = setTimeout(() => {
    if (!state.pendingQuestions.delete(questionId)) return
    entry.release()
    settle('timeout')
  }, timeoutMs)
  if (typeof entry.timer.unref === 'function') entry.timer.unref()
  let result
  try {
    result = await outcome
  } catch {
    result = 'timeout'
  } finally {
    state.pendingQuestions.delete(questionId)
    entry.release()
  }
  if (!result || typeof result !== 'object') return null // open / timeout / abort / release
  if (result.kind === 'option' && typeof result.label === 'string') return { kind: 'option', label: result.label }
  if (result.kind === 'text' && typeof result.text === 'string' && result.text.trim()) {
    return { kind: 'text', text: result.text.trim() }
  }
  return null
}

// ---------------------------------------------------------------------------
// Model tool `windows_notification`
// ---------------------------------------------------------------------------

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Toast title shown as the main line (truncated to 200 characters).',
    },
    body: {
      type: 'string',
      description: 'Toast body text (truncated to 200 characters).',
    },
    actions: {
      type: 'string',
      enum: ['none', 'open', 'dismiss'],
      description: "Buttons for the toast: 'open' adds an Open DeepSeek Harness button, 'dismiss' adds a Dismiss button, 'none' shows no buttons.",
    },
  },
  required: ['title'],
  additionalProperties: false,
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    posted: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['posted'],
}

/** Build the conservative raw tool definition accepted by `ctx.tools.register`. */
function buildToolDefinition(state) {
  return {
    name: 'windows_notification',
    description:
      'Post one native Windows toast notification on behalf of the user, shown as DeepSeek Harness. Use it only when the user explicitly wants a desktop notification; it is not needed for turn completion or approval notices (those are automatic).',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const posted = isRecord(value) ? value.posted === true : false
        const detail = isRecord(value) && typeof value.reason === 'string' ? value.reason : ''
        return [{ type: 'text', text: posted ? 'Windows toast notification posted.' : `Windows toast not posted${detail ? `: ${detail}` : '.'}` }]
      },
    },
    async execute(args) {
      const cfg = state.config
      if (state.disposed) return { posted: false, reason: 'plugin-disposed' }
      if (!cfg.enabled) return { posted: false, reason: 'disabled' }
      const input = isRecord(args) ? args : {}
      const title = clip(input.title, 200)
      if (!title) throw new Error('windows_notification requires a non-empty title')
      const body = clip(input.body, 200)
      const actionsMode = input.actions === 'none' || input.actions === 'open' ? input.actions : 'dismiss'
      const xml = buildCustomToastXml({ cfg, title, body, actionsMode, sessionId: '' })
      const shown = await enqueueToast(state, {
        xml,
        tag: toastTag('custom', String(__internals.now())),
        skipWhenForeground: cfg.skipWhenForeground,
      })
      if (shown.shown) return { posted: true }
      return { posted: false, reason: String(shown.reason || 'not-shown') }
    },
  }
}

/** Register the model tool when the tools service is available (never fatal). */
function installTool(state) {
  try {
    state.ctx.inject(['tools'], (toolsCtx) => {
      try {
        toolsCtx.effect(
          () => toolsCtx.tools.register(buildToolDefinition(state)),
          'dsh-windows-notification: windows_notification tool',
        )
        logTo(state.ctx, 'info', 'windows_notification tool registered')
      } catch (error) {
        logTo(state.ctx, 'warn', 'windows_notification tool registration failed', error)
      }
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'windows_notification tool registration failed', error)
  }
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

/** Create the per-application runtime state. */
function createState(ctx, config) {
  const entry = unwrapConfigValue(config)
  const now = __internals.now()
  return {
    ctx,
    entry: isRecord(entry) ? entry : {},
    source: null,
    config: normalizeSettings(entry),
    bootstrapped: false,
    // v1.3: whether this host still has the old namespace settings service.
    legacySettings: false,
    // v1.3: persisted {testPing,demoPing} baseline for re-apply-safe triggers.
    pingState: null,
    pingStateLoaded: false,
    pingStateWarned: false,
    // v1.4: /ui surface diagnostics + rate limiter buckets.
    startedAt: now,
    lastApplyAt: now,
    uiRate: new Map(),
    bridge: null,
    protocolRegistered: false,
    protocolInFlight: false,
    toastChain: Promise.resolve(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    children: new Set(),
    foregroundCache: null,
    lastAssistant: new Map(),
    lastTurn: new Map(),
    turnStats: new Map(),
    disposed: false,
  }
}

/** Whether the host exposes the old (0.1.x) `settings.installSection` namespace API. */
function detectLegacySettings(ctx) {
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    return Boolean(settings) && typeof settings.installSection === 'function'
  } catch {
    return false
  }
}

/**
 * First-apply seeding / diff-firing for the write-only ping triggers.
 * - old (0.1.x) runtime: changes arrive through `onChange`, so only make sure a
 *   baseline exists here (the settings attach seeds the resolved values);
 * - desktop (0.2.x) runtime: a config edit re-applies the plugin, so the new
 *   config is compared against the persisted baseline and fires exactly once.
 */
function applyPingTriggers(state) {
  try {
    const cfg = state.config
    if (state.legacySettings) {
      if (!readPingState(state)) seedPingState(state, cfg)
      return
    }
    firePingTriggers(state, cfg, runPingTriggers(state, cfg))
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not process the notification ping triggers', error)
  }
}

/** Register the settings namespace via the optional settings service. */
function installSettings(state) {
  try {
    state.ctx.inject(['settings'], (settingsCtx) => {
      try {
        const settings = settingsCtx && settingsCtx.settings
        if (!settings || typeof settings.installSection !== 'function') {
          // Desktop 0.2.x: settings are per-entry Config forms (see exported
          // `Config`); edits re-apply the plugin through `apply(ctx, config)`.
          // There is no namespace API here — stay quiet, this is expected.
          return
        }
        settings.installSection(state.ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, normalizeSettings(state.entry), {
          setSource: (current) => {
            state.source = typeof current === 'function' ? current : () => normalizeSettings(state.entry)
          },
          onChange: () => {
            onSettingsChange(state)
          },
        })
      } catch (error) {
        logTo(state.ctx, 'warn', 'could not install the windows-notification settings section', error)
      }
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not attach to the settings service', error)
  }
}

/** Register event listeners (prepended approval/question waterfalls + session firehose). */
function installListeners(state) {
  try {
    state.ctx.on('session/event', (session, event) => {
      handleSessionEvent(state, session, event)
    })
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not register the session/event listener', error)
  }
  try {
    state.ctx.on(
      'approval/request',
      (request, next) => onApprovalRequest(state, request, next),
      { prepend: true },
    )
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not register the approval/request listener', error)
  }
  try {
    state.ctx.on(
      'user-questions/request',
      (request, next) => onUserQuestionRequest(state, request, next),
      { prepend: true },
    )
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not register the user-questions/request listener', error)
  }
}

/** Register teardown for the bridge, pending approvals/questions, and live PowerShell children. */
function installLifecycle(state) {
  try {
    state.ctx.effect(
      () => {
        return async () => {
          state.disposed = true
          releasePendingApprovals(state, 'cancelled')
          // Pending question claims are released through their listener's next(),
          // so the in-app question UI answers them instead.
          releasePendingQuestions(state, 'released')
          for (const child of [...state.children]) killTree(state, child)
          state.children.clear()
          // Release the bounded per-session caches with the plugin.
          state.turnStats.clear()
          state.lastAssistant.clear()
          state.lastTurn.clear()
          const bridge = state.bridge
          state.bridge = null
          if (bridge) {
            try {
              await bridge.dispose()
            } catch {
              /* teardown is best effort */
            }
          }
        }
      },
      'dsh-windows-notification: lifecycle',
    )
  } catch (error) {
    logTo(state.ctx, 'warn', 'could not register the plugin teardown effect', error)
  }
}

/**
 * Cordis plugin entry. Registers the settings section, the session-event and
 * approval listeners, the model tool, the local bridge, and the protocol
 * handler; all of it only on Windows.
 */
export function apply(ctx, config) {
  let win32 = false
  try {
    win32 = typeof __internals.platform === 'function' && __internals.platform() === 'win32'
  } catch {
    win32 = false
  }
  if (!win32) {
    logTo(ctx, 'warn', 'dsh-windows-notification: native Windows notifications are unavailable on this platform; plugin disabled')
    return
  }
  let state
  try {
    state = createState(ctx, config)
    state.legacySettings = detectLegacySettings(ctx)
  } catch (error) {
    logTo(ctx, 'error', 'dsh-windows-notification failed to initialize', error)
    return
  }
  installLifecycle(state)
  installListeners(state)
  installSettings(state)
  installTool(state)
  // No settings service yet → run from the composition config; a later attach
  // re-runs onSettingsChange and adopts the resolved scope silently.
  state.config = readSettings(state)
  reconcileRuntime(state)
  // v1.3: write-only test/demo triggers must survive the desktop runtime's
  // re-apply-on-edit model; the persisted baseline makes them fire exactly once.
  applyPingTriggers(state)
  // v1.4: /ui/health reports when this instance was (re-)applied.
  state.lastApplyAt = __internals.now()
}
