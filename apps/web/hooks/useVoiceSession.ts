'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { VoiceSocket, type ServerMessage } from '@/lib/websocket'
import { startCapture, AudioPlayer, type CaptureHandle } from '@/lib/audio'
import { createClient } from '@/lib/supabase'
import type { OrbState } from '@/components/VoiceOrb'

export type SessionState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error'
export type BriefType = 'morning' | 'night' | null

export interface PendingTask {
  callId: string
  task: {
    title: string
    type?: string
    due_at?: string
    notes?: string
    repeat_rule?: string
    create_gcal?: boolean
  }
}

export interface UseVoiceSessionReturn {
  sessionState: SessionState
  orbState: OrbState
  errorMessage: string | null
  pendingTasks: PendingTask[]
  isActive: boolean
  savedCount: number
  needsTasksReauth: boolean
  briefMode: BriefType
  toggle: () => void
  requestBrief: (type: 'morning' | 'night') => void
  confirmTask: (callId: string) => Promise<void>
  dismissTask: (callId: string) => void
}

export function useVoiceSession(): UseVoiceSessionReturn {
  const [sessionState, setSessionState] = useState<SessionState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([])
  const [savedCount, setSavedCount] = useState(0)
  const [needsTasksReauth, setNeedsTasksReauth] = useState(false)
  const [briefMode, setBriefMode] = useState<BriefType>(null)

  const socketRef       = useRef<VoiceSocket | null>(null)
  const captureRef      = useRef<CaptureHandle | null>(null)
  const playerRef       = useRef<AudioPlayer | null>(null)
  const captureCtxRef   = useRef<AudioContext | null>(null)
  const sessionStateRef = useRef<SessionState>('idle')
  const briefModeRef    = useRef<BriefType>(null)

  useEffect(() => { sessionStateRef.current = sessionState }, [sessionState])
  useEffect(() => { briefModeRef.current = briefMode }, [briefMode])

  const teardown = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    playerRef.current?.stop()
    playerRef.current = null
    socketRef.current?.disconnect()
    socketRef.current = null
    // Close the capture AudioContext we created during the user gesture
    captureCtxRef.current?.close().catch(() => {})
    captureCtxRef.current = null
    setSessionState('idle')
    setBriefMode(null)
  }, [])

  /** Core connect logic — shared by toggle() and requestBrief() */
  const startSession = useCallback(async () => {
    setErrorMessage(null)
    setSessionState('connecting')

    // ── Create AudioContext HERE during the user-gesture stack ──────────────
    // This is critical: AudioContext must be created synchronously in a click
    // handler. If created later (e.g. in a WS message callback) Chrome suspends
    // it silently and no audio is captured.
    const captureCtx = new AudioContext({ sampleRate: 24000 })
    captureCtxRef.current = captureCtx
    console.log('[session] AudioContext created in user gesture, state:', captureCtx.state)

    const player = new AudioPlayer()
    playerRef.current = player

    const socket = new VoiceSocket({
      onStateChange: (connState) => {
        if (connState === 'error') {
          setSessionState('error')
          teardown()
        }
        if (connState === 'disconnected' && sessionStateRef.current !== 'idle') {
          teardown()
        }
      },

      onMessage: (msg: ServerMessage) => {
        switch (msg.type) {
          case 'session.created': {
            if (msg.needsTasksReauth) setNeedsTasksReauth(true)

            // Start mic capture using the AudioContext created during the click
            startCapture(
              (chunk) => socketRef.current?.sendAudio(chunk),
              captureCtxRef.current!,
            )
              .then((handle) => {
                captureRef.current = handle
                setSessionState('listening')

                // If we entered a brief mode, trigger the brief now
                const mode = briefModeRef.current
                if (mode) {
                  console.log('[session] Triggering brief:', mode)
                  setTimeout(() => {
                    socketRef.current?.sendJSON({ type: 'brief.request', briefType: mode })
                  }, 400)
                }
              })
              .catch((err: unknown) => {
                const isDenied = err instanceof Error && err.name === 'NotAllowedError'
                setErrorMessage(isDenied ? 'Microphone permission denied.' : 'Microphone error.')
                setSessionState('error')
                teardown()
              })
            break
          }

          case 'voice.state':
            if (msg.state === 'speaking') setSessionState('speaking')
            else setSessionState('listening')
            break

          case 'task.pending_confirmation': {
            const incoming: PendingTask = {
              callId: msg.callId,
              task: msg.task as PendingTask['task'],
            }
            setPendingTasks((prev) =>
              prev.some((p) => p.callId === incoming.callId) ? prev : [...prev, incoming]
            )
            break
          }

          case 'session.ended':
            teardown()
            break

          case 'error':
            setErrorMessage(msg.message)
            setSessionState('error')
            teardown()
            break
        }
      },

      onAudio: (chunk) => {
        player.enqueue(chunk)
        if (sessionStateRef.current === 'listening') setSessionState('speaking')
      },
    })

    socketRef.current = socket
    await socket.connect()
  }, [teardown])

  const toggle = useCallback(async () => {
    if (sessionStateRef.current !== 'idle' && sessionStateRef.current !== 'error') {
      teardown()
      return
    }
    setBriefMode(null)
    await startSession()
  }, [teardown, startSession])

  const requestBrief = useCallback(async (type: 'morning' | 'night') => {
    if (sessionStateRef.current !== 'idle' && sessionStateRef.current !== 'error') {
      // Session already active — inject brief request directly
      socketRef.current?.sendJSON({ type: 'brief.request', briefType: type })
      return
    }
    setBriefMode(type)
    await startSession()
  }, [startSession])

  const confirmTask = useCallback(async (callId: string) => {
    const pending = pendingTasks.find((p) => p.callId === callId)
    if (!pending) return

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { error } = await supabase.from('tasks').insert({
      user_id: user.id,
      title: pending.task.title,
      type: pending.task.type ?? 'task',
      due_at: pending.task.due_at ?? null,
      notes: pending.task.notes ?? null,
      repeat_rule: pending.task.repeat_rule ?? null,
      status: 'pending',
      confirmed_at: new Date().toISOString(),
    })

    if (error) {
      console.error('[confirmTask] Supabase error:', error.message)
      setErrorMessage('Failed to save task. Please try again.')
      return
    }

    setPendingTasks((prev) => prev.filter((p) => p.callId !== callId))
    setSavedCount((n) => n + 1)
  }, [pendingTasks])

  const dismissTask = useCallback((callId: string) => {
    setPendingTasks((prev) => prev.filter((p) => p.callId !== callId))
    socketRef.current?.sendJSON({ type: 'task.cancelled', callId })
  }, [])

  const orbState: OrbState =
    sessionState === 'connecting' ? 'processing' :
    sessionState === 'listening'  ? 'listening' :
    sessionState === 'speaking'   ? 'speaking' :
    'idle'

  return {
    sessionState,
    orbState,
    errorMessage,
    pendingTasks,
    isActive: sessionState !== 'idle' && sessionState !== 'error',
    savedCount,
    needsTasksReauth,
    briefMode,
    toggle,
    requestBrief,
    confirmTask,
    dismissTask,
  }
}
