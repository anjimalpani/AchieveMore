'use client'

// ── Capture ───────────────────────────────────────────────────────────────────

export interface CaptureHandle {
  stop: () => void
}

/**
 * Request mic access and start streaming PCM16 at 24 kHz.
 * `onChunk` is called with each raw ArrayBuffer of Int16 samples.
 */
export async function startCapture(onChunk: (pcm16: ArrayBuffer) => void): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

  // Request 24 kHz to match OpenAI Realtime API input format
  const ctx = new AudioContext({ sampleRate: 24000 })
  const source = ctx.createMediaStreamSource(stream)

  // ScriptProcessorNode is deprecated but universally supported;
  // Phase 7 will upgrade to AudioWorklet
  const processor = ctx.createScriptProcessor(4096, 1, 1)

  processor.onaudioprocess = (e) => {
    const float32 = e.inputBuffer.getChannelData(0)
    onChunk(float32ToInt16(float32).buffer as ArrayBuffer)
  }

  source.connect(processor)
  // Must connect to destination to keep the graph alive in some browsers
  processor.connect(ctx.destination)

  return {
    stop: () => {
      processor.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      ctx.close()
    },
  }
}

function float32ToInt16(f32: Float32Array): Int16Array {
  const i16 = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const c = Math.max(-1, Math.min(1, f32[i]))
    i16[i] = c < 0 ? c * 32768 : c * 32767
  }
  return i16
}

// ── Playback ──────────────────────────────────────────────────────────────────

/**
 * Plays back a stream of PCM16 / 24 kHz buffers with seamless scheduling.
 * Call `enqueue(arrayBuffer)` as chunks arrive.
 */
export class AudioPlayer {
  private ctx: AudioContext
  private nextStartTime = 0
  private playing = false

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 24000 })
  }

  enqueue(pcm16: ArrayBuffer): void {
    const i16 = new Int16Array(pcm16)
    const f32 = int16ToFloat32(i16)
    const buf = this.ctx.createBuffer(1, f32.length, 24000)
    buf.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0)

    const source = this.ctx.createBufferSource()
    source.buffer = buf
    source.connect(this.ctx.destination)

    // Schedule back-to-back, starting from now if queue is empty
    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime)
    source.start(startAt)
    this.nextStartTime = startAt + buf.duration
    this.playing = true

    source.onended = () => {
      if (this.nextStartTime <= this.ctx.currentTime) this.playing = false
    }
  }

  stop(): void {
    this.playing = false
    this.nextStartTime = 0
    // Close and recreate so future enqueues work cleanly
    this.ctx.close()
    this.ctx = new AudioContext({ sampleRate: 24000 })
  }

  get isPlaying(): boolean {
    return this.playing
  }
}

function int16ToFloat32(i16: Int16Array): Float32Array {
  const f32 = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / (i16[i] < 0 ? 32768 : 32767)
  }
  return f32
}
