import { WebSocket } from 'ws'
import { UserContext } from './context'

export type SessionState = 'idle' | 'listening' | 'agent_speaking'

export interface UserSession {
  sessionId: string
  userId: string
  ws: WebSocket            // Browser connection
  rtWs: WebSocket | null   // OpenAI Realtime API connection (Phase 3)
  context: UserContext
  state: SessionState
  startedAt: number
  silenceTimer: ReturnType<typeof setTimeout> | null
  // Mutex: tracks which save tool fired first per response turn (keyed by response_id)
  // Prevents the agent from calling both save_task and save_calendar_event in the same turn.
  saveCallsByResponse: Map<string, string>
}

const sessions = new Map<string, UserSession>()

export function createSession(
  sessionId: string,
  userId: string,
  ws: WebSocket,
  context: UserContext
): UserSession {
  const session: UserSession = {
    sessionId,
    userId,
    ws,
    rtWs: null,
    context,
    state: 'idle',
    startedAt: Date.now(),
    silenceTimer: null,
    saveCallsByResponse: new Map(),
  }
  sessions.set(sessionId, session)
  return session
}

export function getSession(sessionId: string): UserSession | undefined {
  return sessions.get(sessionId)
}

export function removeSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session) {
    if (session.silenceTimer) clearTimeout(session.silenceTimer)
    if (session.rtWs && session.rtWs.readyState === WebSocket.OPEN) {
      session.rtWs.close()
    }
    sessions.delete(sessionId)
  }
}

export function getSessionCount(): number {
  return sessions.size
}

/** Count active sessions for a user (rate limit: max 3 per user) */
export function getUserSessionCount(userId: string): number {
  let count = 0
  for (const s of sessions.values()) {
    if (s.userId === userId) count++
  }
  return count
}
