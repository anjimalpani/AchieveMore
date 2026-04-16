/**
 * AudioWorklet processor — runs on the audio rendering thread.
 * Converts Float32 input to Int16 PCM and posts buffers to the main thread.
 */
class PCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = []
    this._bufferSize = 0
    // Accumulate ~128ms of audio before posting (24000 Hz × 0.128s ≈ 3072 samples)
    this._targetSamples = 3072
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const float32 = input[0]
    if (!float32 || float32.length === 0) return true

    // Convert Float32 → Int16
    const int16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      const clamped = Math.max(-1, Math.min(1, float32[i]))
      int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767
    }

    this._buffer.push(int16)
    this._bufferSize += int16.length

    // Post when we have enough samples
    if (this._bufferSize >= this._targetSamples) {
      const merged = new Int16Array(this._bufferSize)
      let offset = 0
      for (const chunk of this._buffer) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      // Transfer ownership to avoid copy
      this.port.postMessage(merged.buffer, [merged.buffer])
      this._buffer = []
      this._bufferSize = 0
    }

    return true
  }
}

registerProcessor('pcm16-processor', PCM16Processor)
