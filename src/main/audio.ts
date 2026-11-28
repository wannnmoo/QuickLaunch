/**
 * 音频设备枚举 / 默认设备切换（Core Audio）。
 *
 * 分两层：
 *  - [`ps.ts`](./ps.ts) 的 `AUDIO_CS` 负责 C# 互操作（IMMDeviceEnumerator + IPolicyConfigVista）；
 *  - 这里负责拼 PowerShell 命令、**按标记解析**、缓存与失效。
 *
 * ⚠️ 输出一律带标记（`AUDIOLIST=` / `AUDIOHR=`），解析只认标记行。
 *  v1.13.8 的教训：PowerShell 会把「未赋值的方法返回值」也写进 stdout，
 *  整段等值判断会被多出来的那一行打死，而功能本身完全正常。
 *
 * ⚠️ 一次调用 ≈ 0.7~1s（powershell.exe 冷启动 + Add-Type 编译 C#），
 *  所以列表要缓存（见 `AUDIO_LIST_TTL_MS`）——卡片每次打开、每个 hover 都去起
 *  一个 PowerShell 进程是不可接受的。切换动作本身慢一点没关系（用户点一下等 1 秒）。
 */
import { AUDIO_CS, runPowerShell } from './ps'
import { logInfo, logWarn } from './logger'
import type { AudioDevice, AudioFlow, AudioSnapshot } from '../shared/types'

// 类型真相源在 src/shared/types.ts（preload / renderer 都从那里取），这里只 re-export
export type { AudioDevice, AudioFlow, AudioSnapshot }

/** MMDeviceAPI 的 EndpointFormFactor（PKEY_AudioEndpoint_FormFactor） */
export const FORMFACTOR = {
  speakers: 1,
  lineLevel: 2,
  headphones: 3,
  microphone: 4,
  headset: 5,
  handset: 6,
  spdif: 8,
  hdmi: 9
} as const

/** 列表缓存时长：够短到「插拔设备后重开卡片就能看到」，够长到「反复开关卡片不起进程」 */
const AUDIO_LIST_TTL_MS = 3000

let cache: { at: number; data: AudioSnapshot } | null = null
let inflight: Promise<AudioSnapshot> | null = null
/** 缓存代际：每次失效 +1，用于作废「失效之前发出的在途请求」的写缓存资格。 */
let cacheGen = 0

/** 音量状态：与设备列表分开缓存（音量变化频繁，列表变化慢）。
 *  300ms 足够挡住「拖动滑块几十次」的抖动，又不至于让外部改动看起来滞后。 */
export type VolumeState = { level: number; mute: boolean }
let volCache: { at: number; data: VolumeState } | null = null
let volInflight: Promise<VolumeState | null> | null = null
const VOLUME_TTL_MS = 300

export function invalidateVolumeCache(): void {
  volCache = null
}

const EMPTY: AudioSnapshot = { render: [], capture: [] }

/** PowerShell 单引号字符串里的引号要写两遍 */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** 从 stdout 里找 `AUDIOLIST=` 那一行；其它行一律忽略（见文件头说明） */
function parseList(stdout: string): AudioSnapshot | null {
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('AUDIOLIST='))
    .pop()
  if (!line) return null
  const raw = line.slice('AUDIOLIST='.length)
  try {
    const parsed: unknown = JSON.parse(raw)
    // ConvertTo-Json 对单元素数组会退化成对象（PS 5.1 没有 -AsArray），这里统一成数组
    const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    const out: AudioSnapshot = { render: [], capture: [] }
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o.id !== 'string' || !o.id) continue
      const flow: AudioFlow = o.flow === 'capture' ? 'capture' : 'render'
      out[flow].push({
        id: o.id,
        name: typeof o.name === 'string' ? o.name : '',
        adapter: typeof o.adapter === 'string' ? o.adapter : '',
        flow,
        formFactor: typeof o.formFactor === 'number' ? o.formFactor : 0,
        isDefault: o.isDefault === true,
        isCommDefault: o.isCommDefault === true
      })
    }
    return out
  } catch (err) {
    logWarn('audio', 'AUDIOLIST 解析失败', err)
    return null
  }
}

function runList(): Promise<AudioSnapshot> {
  const script = `${AUDIO_CS}
$devs = @([QLAudio]::List() | ForEach-Object {
  @{ id = $_.id; name = $_.name; adapter = $_.adapter; flow = $_.flow;
     formFactor = $_.formFactor; isDefault = $_.isDefault; isCommDefault = $_.isCommDefault }
})
if ($devs.Count -eq 0) { Write-Output 'AUDIOLIST=[]' }
else { Write-Output ('AUDIOLIST=' + (ConvertTo-Json -InputObject @($devs) -Compress -Depth 3)) }`

  return new Promise((resolve) => {
    runPowerShell(script, 15000, ({ err, stdout, stderr }) => {
      if (err) {
        logWarn('audio', '枚举音频设备失败（PowerShell）', err)
        // 枚举失败时返回**上一次的列表**而不是空表：空表会让卡片显示「没有可用设备」、
        // Dock 上的音频字形与「音频 · 耳机」标签也一起消失，看起来像功能坏了。
        resolve(cache?.data ?? EMPTY)
        return
      }
      const list = parseList(stdout)
      if (!list) {
        logWarn('audio', `枚举音频设备没有可用输出：${String(stderr ?? '').slice(0, 200)}`)
        resolve(cache?.data ?? EMPTY)
        return
      }
      resolve(list)
    })
  })
}

/**
 * 取设备列表（带缓存与请求合并）。
 * `force = true` 时跳过缓存：切换设备后、以及用户点「刷新」时用。
 */
export function getAudioSnapshot(force = false): Promise<AudioSnapshot> {
  if (!force && cache && Date.now() - cache.at < AUDIO_LIST_TTL_MS) {
    return Promise.resolve(cache.data)
  }
  // ⚠️ `force` **不能**复用 inflight：那是在「切换设备之前」发出的请求，它拿到的默认
  //    设备可能还是旧的。切完之后 renderer 会强刷（loadAudio(true)），若在这里把旧请求
  //    还回去，卡片上的对勾就会先乐观挪过去、一秒后又跳回旧设备（用户得再刷一次才对）。
  if (!force && inflight) return inflight
  const gen = force ? ++cacheGen : cacheGen
  const run = runList().then((data) => {
    const nonEmpty = data.render.length > 0 || data.capture.length > 0
    // 只有「非空」才写缓存：枚举偶尔失败时不要把空表缓存 3 秒，否则卡片会闪成空。
    // 另加代际校验：期间发生过 invalidate（切换设备成功）就丢弃这份过期结果。
    if (nonEmpty && gen === cacheGen) cache = { at: Date.now(), data }
    return data
  })
  if (force) return run
  inflight = run.finally(() => {
    inflight = null
  })
  return inflight
}

/** 缓存失效（切换成功后调用，让卡片立刻反映新状态） */
export function invalidateAudioCache(): void {
  cache = null
  // 作废在途请求的写缓存资格：它是切换**之前**的快照
  cacheGen += 1
}

/**
 * 把某个设备设为默认。
 *
 * `roles` 默认三个全设（0=Console / 1=Multimedia / 2=Communications）——
 * 只设 Console 会出现「系统切了、但微信语音还在旧设备」。
 *
 * 返回 `null` = PowerShell 没跑起来（无法判断）；`[]` = 全部成功；
 * 否则是失败角色对应的 HRESULT（调试用，UI 只需要 true/false）。
 */
export function setDefaultAudioDevice(id: string, roles: number[] = [0, 1, 2]): Promise<number[] | null> {
  const roleList = roles.filter((r) => r === 0 || r === 1 || r === 2).join(',')
  const script = `${AUDIO_CS}
$hr = @()
foreach ($r in @(${roleList})) { $hr += [QLAudio]::SetDefault(${psQuote(id)}, $r) }
Write-Output ('AUDIOHR=' + ($hr -join ','))`

  return new Promise((resolve) => {
    runPowerShell(script, 15000, ({ err, stdout }) => {
      if (err) {
        logWarn('audio', '切换默认音频设备失败（PowerShell）', err)
        resolve(null)
        return
      }
      const line = String(stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('AUDIOHR='))
        .pop()
      if (!line) {
        resolve(null)
        return
      }
      const hrs = line
        .slice('AUDIOHR='.length)
        .split(',')
        .map((v) => Number.parseInt(v, 10))
        .filter((v) => Number.isFinite(v))
      const failed = hrs.filter((v) => v !== 0)
      invalidateAudioCache()
      if (failed.length > 0) logWarn('audio', `SetDefaultEndpoint 返回非零：${failed.join(',')}`)
      else logInfo('audio', `已切换默认设备 roles=${roleList}`)
      resolve(failed)
    })
  })
}

// ─── 音量 / 静音（v1.19.5）─────────────────────────────────────────────────
// 走 AUDIO_CS 里的 IAudioEndpointVolume，作用对象是**当前默认输出设备**（eMultimedia 角色），
// 与「切换默认设备」用的是同一套 Core Audio，切完设备滑块自然跟着走。
// ⚠️ 输出只认 `VOL=` / `VOLERR=` 标记行 —— 与列表同一个坑（见文件头）。

/** 读当前默认输出设备的音量（0-100）与静音状态；失败返回 null。 */
export function getAudioVolume(force = false): Promise<VolumeState | null> {
  const now = Date.now()
  if (!force && volCache && now - volCache.at < VOLUME_TTL_MS) return Promise.resolve(volCache.data)
  if (volInflight) return volInflight
  const script = `${AUDIO_CS}
Write-Output ([QLAudio]::VolumeInfo())`
  volInflight = new Promise<VolumeState | null>((resolve) => {
    runPowerShell(script, 15000, ({ err, stdout }) => {
      if (err) {
        logWarn('audio', '读取音量失败（PowerShell）', err)
        resolve(null)
        return
      }
      const line = String(stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('VOL=') || l.startsWith('VOLERR='))
        .pop()
      if (!line || line.startsWith('VOLERR=')) {
        logWarn('audio', `读取音量失败：${line ?? '无输出'}`)
        resolve(null)
        return
      }
      const m = /VOL=(\d+);MUTE=(\d)/.exec(line)
      if (!m) {
        resolve(null)
        return
      }
      const data: VolumeState = { level: Number(m[1]), mute: m[2] === '1' }
      volCache = { at: Date.now(), data }
      resolve(data)
    })
  }).finally(() => {
    volInflight = null
  })
  return volInflight ?? Promise.resolve(null)
}

/** 设置音量（0-100）。返回 true = 落地。 */
export function setAudioVolume(level: number): Promise<boolean> {
  const pct = Math.max(0, Math.min(100, Math.round(level)))
  // ⚠️ 旧状态必须在**发起调用之前**拍下来：回调里会 invalidateVolumeCache()
  //    （`volCache = null`），而下面的 .then 里要读「当前的静音状态」来写乐观缓存 ——
  //    那时 volCache 已经是 null，`volCache?.data.mute ?? false` 恒等于 false，
  //    于是一次调音量就顺手把 UI 的静音状态改成「未静音」（系统状态其实没变）。
  const prev = volCache?.data
  const script = `${AUDIO_CS}
Write-Output ('VOLLHR=' + [QLAudio]::SetVolume(${pct}))`
  return new Promise<boolean>((resolve) => {
    runPowerShell(script, 15000, ({ err, stdout }) => {
      if (err) {
        logWarn('audio', '设置音量失败（PowerShell）', err)
        resolve(false)
        return
      }
      const ok = String(stdout ?? '').includes('VOLLHR=0')
      invalidateVolumeCache()
      resolve(ok)
    })
  }).then((ok) => {
    // 乐观缓存：滑块是连续拖动的，下一次读不能等 900ms 的 PowerShell。
    // 失败时不写 —— 让下一次读去拿系统的真实值，而不是把一个没落地的值留在缓存里。
    if (ok) volCache = { at: Date.now(), data: { level: pct, mute: prev?.mute ?? false } }
    return ok
  })
}

/** 静音开关。返回 true = 落地。 */
export function setAudioMute(mute: boolean): Promise<boolean> {
  // 与 setAudioVolume 同一条理由：旧音量要在 invalidate 之前拍下来
  const prev = volCache?.data
  const script = `${AUDIO_CS}
Write-Output ('MUTEHR=' + [QLAudio]::SetMute(${mute ? 1 : 0}))`
  return new Promise<boolean>((resolve) => {
    runPowerShell(script, 15000, ({ err, stdout }) => {
      if (err) {
        logWarn('audio', '设置静音失败（PowerShell）', err)
        resolve(false)
        return
      }
      const ok = String(stdout ?? '').includes('MUTEHR=0')
      invalidateVolumeCache()
      resolve(ok)
    })
  }).then((ok) => {
    if (ok) volCache = { at: Date.now(), data: { level: prev?.level ?? 0, mute } }
    return ok
  })
}
