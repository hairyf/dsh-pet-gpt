#!/usr/bin/env node
// Build every DSH video-pet asset from the upstream WebP spritesheets.
//
//   node convert.mjs sync     rebuild pet.json, config.jsonc and webm/ from upstream
//   node convert.mjs preview  rebuild preview/preview.gif from the idle animation
//   node convert.mjs verify   re-check every committed video, GIF and reference
//
// Upstream is hunmer/aboutme-pets; each action is one 8-column WebP atlas whose
// cells are 640x360 frames. Nothing is resampled: frame count, frame rate and
// alpha are carried over verbatim into VP9-alpha WebM.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { alphaStats, decodedRgba, encodeSheet, ffmpegPath, FRAME_BYTES, FRAME_HEIGHT, FRAME_RATE, FRAME_WIDTH, pool, probe, runCapture, unionBox, frameBoxes } from './scripts/lib/media.mjs'
import { categoryOrder, categoryTitles, clickExclude, motionSlots, workStatus } from './scripts/lib/pools.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)))
const upstream = process.env.UPSTREAM_DIR || join(root, '.upstream')
const petDir = join(upstream, 'pets', 'gpt')
const sheetDir = join(petDir, 'spritesheet')
const webmDir = join(root, 'webm')
const previewDir = join(root, 'preview')

const WORK_STATUS_ORDER = ['thinking', 'working', 'result', 'waiting', 'success', 'error']

function upstreamManifest() {
  const manifestFile = join(petDir, 'manifest.json')
  const actionsFile = join(petDir, 'actions.json')
  assert(existsSync(manifestFile), `missing upstream manifest: ${manifestFile}`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  // manifest.json may only list the idle motions while actions.json carries the
  // full catalogue, so always prefer whichever file lists more animations.
  if (existsSync(actionsFile)) {
    const catalog = JSON.parse(readFileSync(actionsFile, 'utf8'))
    if ((catalog.animations?.length ?? 0) > manifest.animations.length) {
      const names = new Set(catalog.animations.map((entry) => entry.name))
      for (const entry of manifest.animations)
        assert(names.has(entry.name), `${entry.name} is missing from the upstream action catalogue`)
      return catalog
    }
  }
  return manifest
}

function actions() {
  const manifest = upstreamManifest()
  const list = manifest.animations.map((entry) => ({
    name: entry.name,
    category: entry.category,
    columns: entry.spritesheet.columns,
    rows: entry.spritesheet.rows,
    frames: entry.spritesheet.frameCount,
    fps: entry.spritesheet.fps,
    frameWidth: entry.spritesheet.frameWidth,
    frameHeight: entry.spritesheet.frameHeight,
  }))
  assert.equal(new Set(list.map((item) => item.name)).size, list.length, 'duplicate upstream action names')
  for (const item of list) {
    assert.equal(item.columns, 8, `${item.name}: atlas must keep 8 columns`)
    assert.equal(item.fps, FRAME_RATE, `${item.name}: unexpected frame rate`)
    assert.equal(item.frameWidth, FRAME_WIDTH, `${item.name}: unexpected frame width`)
    assert.equal(item.frameHeight, FRAME_HEIGHT, `${item.name}: unexpected frame height`)
    assert(existsSync(join(sheetDir, `${item.name}.webp`)), `missing spritesheet for ${item.name}`)
  }
  return list
}

function resolve(candidates, available, fallback) {
  const hit = candidates.find((name) => available.has(name))
  if (hit)
    return hit
  assert(available.has(fallback), `no usable fallback animation: ${fallback}`)
  return fallback
}

function buildConfig(list) {
  const available = new Set(list.map((item) => item.name))
  const idle = resolve(motionSlots.idle, available, list[0].name)
  const motions = {}
  for (const [slot, candidates] of Object.entries(motionSlots))
    motions[slot] = resolve(candidates, available, idle)

  const events = {
    workStatus: WORK_STATUS_ORDER.map((tier) => {
      const picked = []
      for (const name of workStatus[tier]) {
        if (available.has(name) && !picked.includes(name))
          picked.push(name)
      }
      return picked.length > 0 ? picked : [idle]
    }),
  }

  const excluded = new Set([...Object.values(motions), ...clickExclude])
  const clicks = list.map((item) => item.name).filter((name) => !excluded.has(name))
  assert(clicks.length > 0, 'click pool must not be empty')

  const grouped = new Map(categoryOrder.map((id) => [id, []]))
  for (const item of list) {
    if (!grouped.has(item.category))
      grouped.set(item.category, [])
    grouped.get(item.category).push(item.name)
  }
  const categories = [...grouped.entries()]
    .filter(([, names]) => names.length > 0)
    .map(([id, names]) => ({ id, title: categoryTitles[id] ?? id, weight: 10, actions: names }))

  return {
    motions,
    animations: {
      idle: [idle],
      turn: [motions.turn],
      drag: [motions.dragging],
      clicks,
      moves: { actions: [{ name: motions['moving-left'], direction: 'left' }, { name: motions['moving-right'], direction: 'right' }] },
      categories,
      events,
    },
    animationWeights: { idle: 60, turn: 0, move: 0 },
  }
}

function referencedNames(config) {
  const names = new Set()
  const add = (value) => {
    if (typeof value === 'string')
      names.add(value)
    else if (Array.isArray(value))
      value.forEach(add)
  }
  add(Object.values(config.motions ?? {}))
  const pools = config.animations ?? {}
  add(pools.idle)
  add(pools.turn)
  add(pools.drag)
  add(pools.clicks)
  add(Object.values(pools.motions ?? {}))
  add((pools.moves?.actions ?? []).map((action) => action.name))
  for (const category of pools.categories ?? [])
    add(category.actions)
  for (const slot of Object.values(pools.events ?? {}))
    add(slot)
  return names
}

function configJsonc(config, list) {
  const available = new Set(list.map((item) => item.name))
  const referenced = referencedNames(config)
  const missing = [...referenced].filter((name) => !available.has(name))
  const spare = [...available].filter((name) => !referenced.has(name))
  const header = [
    '// DSH video pet configuration.',
    '//',
    '// motions drive the fixed slots (idle / turn / move / drag / waiting).',
    '// animations.clicks is the random pool played on a click.',
    '// animations.events.workStatus keeps the six-tier agent status order.',
    '//',
    '// Generated by scripts/convert.mjs sync from hunmer/aboutme-pets.',
    '// Change scripts/lib/pools.mjs and regenerate instead of editing this file.',
    `// animations: ${available.size} shipped, ${referenced.size} referenced, ${spare.length} spare`,
    ...(spare.length > 0 ? [`// spare (still shipped): ${spare.join('、')}`] : []),
    ...(missing.length > 0 ? [`// WARNING unresolved references: ${missing.join('、')}`] : []),
  ].join('\n')
  return `${header}\n${JSON.stringify(config, null, 2)}\n`
}

function petJson(list) {
  return JSON.stringify({
    id: 'dsh-pet-gpt',
    kind: 'dsh',
    displayName: 'GPT 桌宠',
    description: "193 个透明动作的 GPT 桌宠，640×360 画布、12 fps，含透明待机动画。",
    configPath: 'config.jsonc',
    uriPath: 'webm',
    macUriPath: 'mov',
    previewPath: 'preview/preview.gif',
    ext: { default: 'webm', mac: 'mov' },
    size: 220,
  }, null, 2) + '\n'
}

async function convert() {
  const list = actions()
  const config = buildConfig(list)
  mkdirSync(webmDir, { recursive: true })
  assert.equal(readdirSync(sheetDir).filter((name) => name.endsWith('.webp')).length >= list.length, true)

  const jobs = list.filter((item) => !existsSync(join(webmDir, `${item.name}.webm`)) || process.env.FORCE === '1')
  console.log(`${list.length} actions, ${jobs.length} to encode`)

  let done = 0
  const started = Date.now()
  await pool(jobs, async (item) => {
    const output = join(webmDir, `${item.name}.webm`)
    await encodeSheet({ sheet: join(sheetDir, `${item.name}.webp`), rows: item.rows, frameCount: item.frames, output, crf: Number(process.env.CRF || 32) })
    const media = await probe(output)
    const stream = media.streams[0]
    assert.equal(stream.codec_name, 'vp9', output)
    assert.equal(Number(stream.nb_read_frames), item.frames, `${output}: frame count changed`)
    void stream
    done += 1
    console.log(`[${done}/${jobs.length}] ${item.name} (${item.frames}f, ${(statSync(output).size / 1024).toFixed(0)} KiB)`)
  }, Number(process.env.JOBS || 0) || Math.max(1, (await import('node:os')).cpus().length - 1))

  writeFileSync(join(root, 'pet.json'), petJson(list))
  writeFileSync(join(root, 'config.jsonc'), configJsonc(config, list))
  console.log(`encoded ${jobs.length} animations in ${((Date.now() - started) / 1000).toFixed(0)}s`)
}

function gifFrames(buffer) {
  let index = 13 + (buffer[10] & 0x80 ? 3 * 2 ** ((buffer[10] & 0x07) + 1) : 0)
  let frames = 0
  const skipSubBlocks = () => {
    while (index < buffer.length && buffer[index] !== 0)
      index += buffer[index] + 1
    index += 1
  }
  while (index < buffer.length && buffer[index] !== 0x3B) {
    if (buffer[index] === 0x21) {
      index += 2
      skipSubBlocks()
    }
    else if (buffer[index] === 0x2C) {
      frames += 1
      index += 9
      const flags = buffer[index]
      index += 1
      if (flags & 0x80)
        index += 3 * 2 ** ((flags & 0x07) + 1)
      index += 1
      skipSubBlocks()
    }
    else {
      throw new Error('unexpected GIF block')
    }
  }
  return frames
}

async function preview() {
  mkdirSync(previewDir, { recursive: true })
  const list = actions()
  const available = new Set(list.map((item) => item.name))
  const idle = resolve(motionSlots.idle, available, list[0].name)
  const idleWebm = join(webmDir, `${idle}.webm`)

  // Square crop around the union of every opaque pixel of the idle animation,
  // taken from the decoded video itself so the GIF matches what the host plays.
  const decoded = await decodedRgba(idleWebm, { frames: 24 })
  const box = unionBox(frameBoxes(decoded, Math.floor(decoded.length / FRAME_BYTES)))
  assert(box, 'idle animation is fully transparent')
  const pad = 14
  const x0 = Math.max(0, box.x0 - pad)
  const y0 = Math.max(0, box.y0 - pad)
  const x1 = Math.min(FRAME_WIDTH - 1, box.x1 + pad)
  const y1 = Math.min(FRAME_HEIGHT - 1, box.y1 + pad)
  const width = x1 - x0 + 1
  const height = y1 - y0 + 1
  const side = Math.max(width, height)
  const target = join(previewDir, 'preview.gif')
  if (process.env.FORCE !== '1' && existsSync(target) && statSync(target).mtimeMs >= statSync(idleWebm).mtimeMs) {
    console.log(`preview ${idle}: up to date`)
    return
  }

  const filter = [
    `crop=${width}:${height}:${x0}:${y0}`,
    `scale=${side}:${side}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${side}:${side}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    'format=rgba',
    'split[source][palette-input]',
    '[palette-input]palettegen=reserve_transparent=1:stats_mode=diff[palette]',
    '[source][palette]paletteuse=alpha_threshold=128:dither=sierra2_4a',
  ].join(',')

  await runCapture(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-c:v', 'libvpx-vp9', '-i', idleWebm,
    '-filter_complex', filter,
    '-loop', '0', '-an', '-f', 'gif', target,
  ], 'preview gif')

  // A single transparent PNG frame is handy for README headers and issue reports.
  await runCapture(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-c:v', 'libvpx-vp9', '-i', idleWebm,
    '-vf', `crop=${width}:${height}:${x0}:${y0}`,
    '-frames:v', '1', join(previewDir, 'idle.png'),
  ], 'preview png')

  const gif = readFileSync(target)
  assert(gif.subarray(0, 6).toString('ascii').startsWith('GIF8'), 'preview must be a GIF')
  const gifWidth = gif.readUInt16LE(6)
  const gifHeight = gif.readUInt16LE(8)
  assert.equal(gifWidth, gifHeight, 'preview must be square')
  console.log(`preview ${idle}: ${gifWidth}x${gifHeight}, ${(gif.length / 1024).toFixed(0)} KiB, ${gifFrames(gif)} frames, ${width}x${height} PNG`)
}

async function verify() {
  const list = actions()
  const names = new Set(list.map((item) => item.name))
  const webm = readdirSync(webmDir).filter((name) => name.endsWith('.webm'))
  const expected = [...names].map((name) => `${name}.webm`).sort()
  assert.deepEqual(webm.sort(), expected, 'webm/ must contain exactly the upstream animations')

  // HEVC-with-alpha MOV can only be produced by AVAssetWriter, so a Windows or
  // Linux checkout legitimately has no mov/ yet; CI always verifies them.
  const checkMov = process.env.SKIP_MOV !== '1'
  const movs = checkMov ? readdirSync(join(root, 'mov')).filter((name) => name.endsWith('.mov')) : []
  if (checkMov)
    assert.deepEqual(movs.sort(), [...names].map((name) => `${name}.mov`).sort(), 'mov/ must contain exactly the upstream animations')

  for (const item of list) {
    const webmFile = join(webmDir, `${item.name}.webm`)
    const media = await probe(webmFile)
    const stream = media.streams[0]
    assert.equal(stream.codec_name, 'vp9', webmFile)
    assert.equal(stream.width, FRAME_WIDTH, webmFile)
    assert.equal(stream.height, FRAME_HEIGHT, webmFile)
    assert.equal(stream.r_frame_rate, `${FRAME_RATE}/1`, webmFile)
    assert.equal(Number(stream.nb_read_frames), item.frames, `${webmFile}: frame count changed`)
    assert(Math.abs(Number(media.format.duration) - item.frames / FRAME_RATE) <= 1 / FRAME_RATE + 0.05, `${webmFile}: duration changed`)
    const alpha = await alphaStats(webmFile, { frames: 12 })
    assert(alpha.min < 32 && alpha.max > 223, `${webmFile}: transparency lost`)
    if (checkMov) {
      const mov = await probe(join(root, 'mov', `${item.name}.mov`))
      const movStream = mov.streams[0]
      assert.equal(movStream.codec_name, 'hevc', `${item.name}.mov`)
      assert.equal(movStream.codec_tag_string, 'hvc1', `${item.name}.mov`)
      assert.equal(movStream.width, FRAME_WIDTH, `${item.name}.mov`)
      assert.equal(movStream.height, FRAME_HEIGHT, `${item.name}.mov`)
    }
  }

  const config = JSON.parse(readFileSync(join(root, 'config.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const referenced = referencedNames(config)
  for (const name of referenced) {
    assert(statSync(join(webmDir, `${name}.webm`)).size > 0, `${name}: missing webm`)
    if (checkMov)
      assert(statSync(join(root, 'mov', `${name}.mov`)).size > 0, `${name}: missing mov`)
  }
  assert.equal(config.animations.events.workStatus.length, 6, 'workStatus must keep six tiers')
  assert.equal(new Set(config.animations.clicks).size, config.animations.clicks.length, 'clicks must be unique')

  const pet = JSON.parse(readFileSync(join(root, 'pet.json'), 'utf8'))
  assert.equal(pet.ext.default, 'webm')
  assert.equal(pet.ext.mac, 'mov')
  assert.equal(pet.macUriPath, 'mov')

  const gif = readFileSync(join(previewDir, 'preview.gif'))
  assert(gif.subarray(0, 6).toString('ascii').startsWith('GIF8'), 'preview must be a GIF')
  assert.equal(gif.readUInt16LE(6), gif.readUInt16LE(8), 'preview must be square')
  console.log(`ok: ${list.length} VP9-alpha WebM, ${movs.length} HEVC-alpha MOV, ${referenced.size} referenced animations, square ${gif.readUInt16LE(6)}px GIF`)
}

const { positionals } = parseArgs({ allowPositionals: true })
const command = positionals[0]
assert(['sync', 'preview', 'verify'].includes(command), 'usage: node convert.mjs sync|preview|verify')
if (command === 'sync')
  await convert()
if (command === 'preview')
  await preview()
if (command === 'verify')
  await verify()
