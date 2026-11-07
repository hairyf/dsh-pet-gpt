// Shared ffmpeg helpers for the DSH pet asset pipeline.
//
// Upstream ships 8-column WebP atlases holding one 640x360 frame per cell. The
// atlas is decoded to packed RGBA once, sliced into individual frames in
// process and streamed into the VP9-alpha encoder, so frame count, timing and
// the alpha channel survive the round trip unchanged.

import { spawn } from 'node:child_process'
import { once } from 'node:events'

export const FRAME_WIDTH = 640
export const FRAME_HEIGHT = 360
export const FRAME_RATE = 12
export const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 4

export function ffmpegPath() {
  return process.env.FFMPEG || 'ffmpeg'
}

export function ffprobePath() {
  if (process.env.FFPROBE)
    return process.env.FFPROBE
  const ffmpeg = ffmpegPath()
  if (ffmpeg === 'ffmpeg')
    return 'ffprobe'
  return ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_, ext) => `ffprobe${ext ?? ''}`)
}

function collect(child, label) {
  const chunks = []
  let stderr = ''
  child.stdout?.on('data', (chunk) => { chunks.push(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  return {
    done: async () => {
      const [code] = await once(child, 'close')
      if (code !== 0)
        throw new Error(`${label} exited with code ${code}: ${stderr.trim().slice(-2000)}`)
      return Buffer.concat(chunks)
    },
  }
}

export function runCapture(exe, args, label = exe) {
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  return collect(child, label).done()
}

export async function probe(path) {
  const output = await runCapture(ffprobePath(), [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,codec_tag_string,pix_fmt,width,height,r_frame_rate,nb_read_frames,nb_frames,duration',
    '-show_entries', 'format=duration,size',
    '-of', 'json', path,
  ], `ffprobe ${path}`)
  return JSON.parse(output.toString('utf8'))
}

// Framing inside the 640x360 canvas.
//
// The host renders every DSH pet video into a fixed 16:9 box and hangs the
// status bubble a few percent below the top edge of that box. Upstream frames
// put the top of the head at ~10% of the canvas height, i.e. directly under the
// bubble, which reads as "the bubble is sitting on the pet's head".
//
// So the whole frame - never a crop, every pixel survives - is scaled down and
// re-padded lower in the canvas: the head lands at ~27% of the canvas instead
// of ~10%. The canvas keeps its 640x360 size and 9/16 aspect, so the host's
// window geometry is untouched while the bubble gains a clear band above the
// character. FRAME_FIT applies to every frame, so frame-to-frame motion isnot
// distorted; the uniforms keep the worst-case "content already touches the
// canvas edge" actions inside the frame as well.
export const FRAME_FIT = {
  /** Scale applied to the full 640x360 frame; 1 = untouched upstream frame. */
  scale: 0.8,
  /** Transparent margin kept below the scaled frame (px); 0 grounds the feet. */
  bottom: 0,
  /**
   * Bubble clearance. The host hangs the status bubble with
   * `bottom: calc(100% - petSize * 0.108)`, i.e. its lower edge sits at
   * 0.108 / (9/16) = 19.2% of the video box height - 69px on this canvas.
   * Upstream puts the top of the head at 10% (36px), which the bubble covers,
   * and some actions (raised hands, falling leaves, a jump) reach y=0.
   * Anchoring the scaled frame to the bottom keeps the feet grounded and puts
   * even those worst-case frames at 72px - just below the 69px bubble line -
   * while the character shrinks by the same 0.8 factor. pet.json `size` is
   * raised to 265 so the character keeps its previous on-screen height.
   */
  bubbleline: Math.round(0.108 / (9 / 16) * FRAME_HEIGHT),
}

/** ffmpeg filter that tiles the atlas and re-frames it inside the canvas. */
export function sheetFilter(rows) {
  const width = Math.round((FRAME_WIDTH * FRAME_FIT.scale) / 2) * 2
  const height = Math.round((FRAME_HEIGHT * FRAME_FIT.scale) / 2) * 2
  const x = Math.floor((FRAME_WIDTH - width) / 2)
  const y = FRAME_HEIGHT - height - FRAME_FIT.bottom
  return [
    `untile=8x${rows}`,
    'format=rgba',
    `scale=${width}:${height}:flags=lanczos`,
    `pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:${x}:${y}:color=black@0`,
  ].join(',')
}

// Whole atlas, tiled into its 8-column cells, re-framed and emitted as a packed
// RGBA frame sequence: untile is what turns the 8xR grid into 640x360 frames, a
// plain byte slice of the atlas would cut across atlas rows.
export async function decodeSheet(sheet, rows) {
  return runCapture(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', sheet, '-vf', sheetFilter(rows), '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], `decode ${sheet}`)
}

export function sheetFrame(raw, index) {
  const start = index * FRAME_BYTES
  if (start + FRAME_BYTES > raw.length)
    throw new Error(`sheet has only ${Math.floor(raw.length / FRAME_BYTES)} frames, wanted ${index + 1}`)
  return raw.subarray(start, start + FRAME_BYTES)
}

// Streams packed RGBA frames into a VP9-alpha WebM.
export async function encodeFrames(frames, output, { crf = 32, cpuUsed = 4 } = {}) {
  const encoder = spawn(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${FRAME_WIDTH}x${FRAME_HEIGHT}`,
    '-framerate', String(FRAME_RATE),
    '-i', '-',
    '-an',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-b:v', '0', '-crf', String(crf),
    '-deadline', 'good', '-cpu-used', String(cpuUsed),
    '-row-mt', '1', '-auto-alt-ref', '0',
    '-f', 'webm', output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] })

  let stderr = ''
  encoder.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const closed = new Promise((resolve, reject) => {
    encoder.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`encode ${output} exited with code ${code}: ${stderr.trim().slice(-1200)}`)))
    encoder.on('error', reject)
  })
  for (const frame of frames) {
    if (!encoder.stdin.write(frame))
      await once(encoder.stdin, 'drain')
  }
  encoder.stdin.end()
  await closed
}

export async function encodeSheet({ sheet, rows, frameCount, output, crf, cpuUsed }) {
  const raw = await decodeSheet(sheet, rows)
  const available = Math.floor(raw.length / FRAME_BYTES)
  if (available < frameCount)
    throw new Error(`${sheet}: sheet holds ${available} frames but ${frameCount} were declared`)
  const frames = Array.from({ length: frameCount }, (_, index) => sheetFrame(raw, index))
  await encodeFrames(frames, output, { crf, cpuUsed })
}

// Alpha plane statistics. Several ffmpeg builds (notably 9.x) decode VP9 alpha
// with the native decoder and silently drop it, so force libvpx-vp9 here.
export async function alphaStats(path, { frames = 0 } = {}) {
  const args = ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', path]
  if (frames > 0)
    args.push('-frames:v', String(frames))
  args.push('-vf', 'format=rgba,alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-')
  const gray = await runCapture(ffmpegPath(), args, `alpha probe ${path}`)
  let min = 255
  let max = 0
  for (const value of gray) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return { bytes: gray.length, min, max, frames: gray.length / (FRAME_WIDTH * FRAME_HEIGHT) }
}

export async function decodedRgba(path, { frames = 1 } = {}) {
  return runCapture(ffmpegPath(), [
    '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
    '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], `rgba probe ${path}`)
}

export function frameBoxes(raw, frameCount, width = FRAME_WIDTH, height = FRAME_HEIGHT) {
  const frameBytes = width * height * 4
  const boxes = []
  for (let index = 0; index < frameCount; index += 1) {
    const base = index * frameBytes
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < height; y += 1) {
      const row = base + y * width * 4
      for (let x = 0; x < width; x += 1) {
        if (raw[row + x * 4 + 3] > 16) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (x1 >= 0)
      boxes.push({ x0, y0, x1, y1 })
  }
  return boxes
}

export function unionBox(boxes) {
  if (boxes.length === 0)
    return null
  return boxes.reduce((acc, box) => ({
    x0: Math.min(acc.x0, box.x0),
    y0: Math.min(acc.y0, box.y0),
    x1: Math.max(acc.x1, box.x1),
    y1: Math.max(acc.y1, box.y1),
  }))
}

export async function pool(items, worker, size = 4) {
  const results = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}
