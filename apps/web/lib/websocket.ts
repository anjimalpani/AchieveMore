'use client'

import { createClient } from './supabase'

export type ServerMessage =
  | { type: 'session.created'; sessionId: string; userId: string; message: string; needsTasksReauth?: boolean }
  | { type: 'session.ended'; reason: string }
  | { type: 'voice.state'; state: 'idle' | 'listening' | 'speaking' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'task.pending_confirmation'; task: Record<string, unknown>; callId: string }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

interface VoiceSocketOptions {
  onMessage: (msg: ServerMessage) => void
  onStateChange: (state: ConnectionState) => void
  onAudio: (chunk: ArrayBuffer) => void
}

export class VoiceSocket {
  private ws: WebSocket | null = null
  private opts: VoiceSocketOptions

  constructor(opts: VoiceSocketOptions) {
    this.opts = opts
  }

  async connect(): Promise<void> {
    const voiceServerUrl = process.env.NEXT_PUBLIC_VOICE_SERVER_URL
    if (!voiceServerUrl) {
      this.opts.onStateChange('error')
      console.error('[VoiceSocket] NEXT_PUBLIC_VOICE_SERVER_URL is not set')
      return
    }

    // Get the current Supabase session token
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      this.opts.onStateChange('error')
      console.error('[VoiceSocket] No active session — user not logged in')
      return
    }

    // Include browser timezone so the voice server uses the correct local date
    const browserTz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)
    const url = `${voiceServerUrl}?token=${encodeURIComponent(session.access_token)}&tz=${browserTz}`
    this.opts.onStateChange('connecting')

    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = () => {
      console.log('[VoiceSocket] Connected')
      this.opts.onStateChange('connected')
    }

    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.opts.onAudio(event.data)
        return
      }
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage
        this.opts.onMessage(msg)
      } catch {
        console.warn('[VoiceSocket] Unparseable message', event.data)
      }
    }

    this.ws.onclose = (event) => {
      console.log(`[VoiceSocket] Closed — code ${event.code}, reason: ${event.reason}`)
      this.opts.onStateChange('disconnected')
      this.ws = null
    }

    this.ws.onerror = (event) => {
      console.error('[VoiceSocket] Error', event)
      this.opts.onStateChange('error')
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    }
  }

  sendJSON(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  disconnect(): void {
    this.sendJSON({ type: 'session.end' })
    this.ws?.close(1000, 'User ended session')
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
