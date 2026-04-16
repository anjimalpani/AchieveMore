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
      this.opts.onMessage({ type: 'error', code: 'config_error', message: 'Voice server URL not configured. Check NEXT_PUBLIC_VOICE_SERVER_URL.' })
      console.error('[VoiceSocket] NEXT_PUBLIC_VOICE_SERVER_URL is not set')
      return
    }

    // Get the current Supabase session token
    let session
    try {
      const supabase = createClient()
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error
      session = data.session
    } catch (err) {
      this.opts.onStateChange('error')
      this.opts.onMessage({ type: 'error', code: 'auth_error', message: 'Failed to retrieve session. Try signing out and back in.' })
      console.error('[VoiceSocket] getSession failed:', err)
      return
    }

    if (!session?.access_token) {
      this.opts.onStateChange('error')
      this.opts.onMessage({ type: 'error', code: 'no_session', message: 'Not signed in. Please refresh the page.' })
      console.error('[VoiceSocket] No active session — user not logged in')
      return
    }

    // Include browser timezone so the voice server uses the correct local date
    const browserTz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)
    const url = `${voiceServerUrl}?token=${encodeURIComponent(session.access_token)}&tz=${browserTz}`
    console.log('[VoiceSocket] Connecting to', voiceServerUrl)
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
      const AUTH_CODES: Record<number, string> = {
        1008: 'Connection rejected by server (auth failed — token may be expired).',
        4001: 'Authentication failed. Please sign out and back in.',
        4002: 'Rate limited — too many active sessions.',
        4003: 'Failed to load user data on the server.',
      }
      const reason = AUTH_CODES[event.code] ?? event.reason ?? `Closed (code ${event.code})`
      console.log(`[VoiceSocket] Closed — code ${event.code}, reason: ${reason}`)
      if (event.code !== 1000 && event.code !== 1001) {
        this.opts.onMessage({ type: 'error', code: `ws_close_${event.code}`, message: reason })
      }
      this.opts.onStateChange('disconnected')
      this.ws = null
    }

    this.ws.onerror = () => {
      // onerror always fires before onclose when the connection fails;
      // the actual reason comes from the close event so we log there.
      console.error('[VoiceSocket] WebSocket error (see close event for reason)')
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
