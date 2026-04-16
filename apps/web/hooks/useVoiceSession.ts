'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { VoiceSocket, type ServerMessage } from '@/lib/websocket'
import { startCapture, AudioPlayer, type CaptureHandle } from '@/lib/audio'
import { createClient } from '@/lib/supabase'
import type { OrbState } from '@/components/VoiceOrb'

export type SessionState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error'

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
  savedCount: number           // increments on each save — use as useEffect dep to refresh task list
  needsTasksReauth: boolean    // voice server told us Tasks scope is missing
  toggle: () => void
  confirmTask: (callId: string) => Promise<void>
  dismissTask: (callId: string) => void
}

export function useVoiceSession(): UseVoiceSessionReturn {
  const [sessionState, setSessionState] = useState<SessionState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([])
  const [savedCount, setSavedCount] = useState(0)
  const [needsTasksReauth, setNeedsTasksReauth] = useState(false)

  const socketRef = useRef<VoiceSocket | null>(null)
  const captureRef = useRef<CaptureHandle | null>(null)
  const playerRef = useRef<AudioPlayer | null>(null)
  const sessionStateRef = useRef<SessionState>('idle')

  useEffect(() => { sessionStateRef.current = sessionState }, [sessionState])

  const teardown = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    playerRef.current?.stop()
    playerRef.current = null
    socketRef.current?.disconnect()
    socketRef.current = null
    setSessionState('idle')
    // Keep pending tasks visible after session ends — user may still want to save them
  }, [])

  const toggle = useCallback(async () => {
    if (sessionStateRef.current !== 'idle' && sessionStateRef.current !== 'error') {
      teardown()
      return
    }

    setErrorMessage(null)
    setSessionState('connecting')

    const player = new AudioPlayer()
    playerRef.current = player

    const socket = new VoiceSocket({
      onStateChange: (connState) => {
        if (connState === 'error') {
          setErrorMessage('Could not connect to voice server.')
          setSessionState('error')
          teardown()
        }
        if (connState === 'disconnected' && sessionStateRef.current !== 'idle') {
          teardown()
        }
      },

      onMessage: (msg: ServerMessage) => {
        switch (msg.type) {
          case 'session.created':
            if (msg.needsTasksReauth) setNeedsTasksReauth(true)
            startCapture((chunk) => socketRef.current?.sendAudio(chunk))
              .then((handle) => {
                captureRef.current = handle
                setSessionState('listening')
              })
              .catch((err: unknown) => {
                const isDenied = err instanceof Error && err.name === 'NotAllowedError'
                setErrorMessage(isDenied ? 'Microphone permission denied.' : 'Microphone error.')
                setSessionState('error')
                teardown()
              })
            break

          case 'voice.state':
            if (msg.state === 'speaking') setSessionState('speaking')
            else setSessionState('listening')
            break

          case 'task.pending_confirmation': {
            const incoming: PendingTask = {
              callId: msg.callId,
              task: msg.task as PendingTask['task'],
            }
            // Deduplicate by callId in case of duplicate events
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

  /** Save the task to Supabase and remove the card */
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

  /** Dismiss without saving */
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
    toggle,
    confirmTask,
    dismissTask,
  }
}
