'use client'

// ── Capture ───────────────────────────────────────────────────────────────────

export interface CaptureHandle {
  stop: () => void
}

/**
 * Request mic access and start streaming PCM16 at 24 kHz to `onChunk`.
 *
 * IMPORTANT: `ctx` MUST be created in a user-gesture handler (button click)
 * before calling this function. If created inside a WS/async callback the
 * browser suspends it silently and onaudioprocess never fires.
 */
export async function startCapture(
  onChunk: (pcm16: ArrayBuffer) => void,
  ctx: AudioContext,
): Promise<CaptureHandle> {
  console.log('[audio] Requesting microphone...')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  console.log('[audio] Mic granted')

  // Resume in case the context was created slightly before a gesture resolved
  if (ctx.state === 'suspended') {
    console.log('[audio] AudioContext suspended — resuming...')
    await ctx.resume()
  }
  console.log('[audio] AudioContext running | sampleRate:', ctx.sampleRate, '| state:', ctx.state)

  const source = ctx.createMediaStreamSource(stream)

  // ── Try AudioWorklet (preferred — runs off the main thread) ─────────────────
  try {
    await ctx.audioWorklet.addModule('/pcm16-processor.js')
    const worklet = new AudioWorkletNode(ctx, 'pcm16-processor')

    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      console.log('[audio] Sending audio chunk (worklet), bytes:', e.data.byteLength)
      onChunk(e.data)
    }

    source.connect(worklet)
    // Don't connect worklet to destination — we don't want to hear our own mic
    console.log('[audio] Using AudioWorklet')

    return {
      stop: () => {
        console.log('[audio] Stopping capture')
        worklet.disconnect()
        source.disconnect()
        stream.getTracks().forEach((t) => t.stop())
      },
    }
  } catch (workletErr) {
    // ── Fallback: ScriptProcessorNode (deprecated but universally supported) ──
    console.warn('[audio] AudioWorklet unavailable, falling back to ScriptProcessor:', workletErr)

    const processor = ctx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0)
      const buffer = float32ToInt16(float32).buffer as ArrayBuffer
      console.log('[audio] Sending audio chunk (ScriptProcessor), bytes:', buffer.byteLength)
      onChunk(buffer)
    }

    source.connect(processor)
    // Must connect to destination to keep the graph alive in some browsers
    processor.connect(ctx.destination)
    console.log('[audio] Using ScriptProcessor')

    return {
      stop: () => {
        console.log('[audio] Stopping capture')
        processor.disconnect()
        source.disconnect()
        stream.getTracks().forEach((t) => t.stop())
      },
    }
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
  private _playing = false

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 24000 })
  }

  enqueue(pcm16: ArrayBuffer): void {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }

    const i16 = new Int16Array(pcm16)
    const f32 = int16ToFloat32(i16)
    const buf = this.ctx.createBuffer(1, f32.length, 24000)
    buf.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0)

    const source = this.ctx.createBufferSource()
    source.buffer = buf
    source.connect(this.ctx.destination)

    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime)
    source.start(startAt)
    this.nextStartTime = startAt + buf.duration
    this._playing = true

    source.onended = () => {
      if (this.nextStartTime <= this.ctx.currentTime) this._playing = false
    }
  }

  stop(): void {
    this._playing = false
    this.nextStartTime = 0
    this.ctx.close()
    this.ctx = new AudioContext({ sampleRate: 24000 })
  }

  get isPlaying(): boolean {
    return this._playing
  }
}

function int16ToFloat32(i16: Int16Array): Float32Array {
  const f32 = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / (i16[i] < 0 ? 32768 : 32767)
  }
  return f32
}
