import 'dotenv/config'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { randomUUID } from 'crypto'
import { verifyToken } from './auth'
import { loadUserContext } from './context'
import { createSession, removeSession, getUserSessionCount, getSessionCount } from './session'
import { openRealtimeSession, sendAudioChunk } from './realtime'
import { handleFunctionCall } from './actions'
import { getOAuthUrl, exchangeAndStoreTokens } from './calendar'
import { createClient } from '@supabase/supabase-js'
import { generateTomorrowSummary } from './summary'
import { buildHealthResponse } from './health'

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

const PORT = parseInt(process.env.PORT ?? '8080', 10)
const MAX_SESSION_MS = 15 * 60 * 1000  // 15 min hard cap
const SILENCE_TIMEOUT_MS = 30 * 1000   // 30s of no audio → end session
const MAX_SESSIONS_PER_USER = 3


// ── HTTP server (health + calendar OAuth + WS upgrade) ───────────────────────
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost`)

  // Health check
  if (url.pathname === '/health') {
    const body = buildHealthResponse()
    res.writeHead(body.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }

  // Google Calendar OAuth — initiate (browser redirects here with a Supabase JWT)
  // GET /calendar/connect?token=<supabase_jwt>
  if (url.pathname === '/calendar/connect') {
    const token = url.searchParams.get('token')
    if (!token) { res.writeHead(400); res.end('Missing token'); return }
    try {
      await verifyToken(token)  // validate but we don't need userId here — just guard the route
      const oauthUrl = getOAuthUrl()
      // Embed the supabase token in the state param so we can identify the user on callback
      const withState = oauthUrl + `&state=${encodeURIComponent(token)}`
      res.writeHead(302, { Location: withState })
      res.end()
    } catch {
      res.writeHead(401); res.end('Unauthorized')
    }
    return
  }

  // Google Calendar OAuth — callback
  // GET /calendar/callback?code=...&state=<supabase_jwt>
  if (url.pathname === '/calendar/callback') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) { res.writeHead(400); res.end('Missing code or state'); return }

    try {
      const { sub: userId } = await verifyToken(state)
      await exchangeAndStoreTokens(userId, code)
      console.log(`[calendar] Tokens stored for user ${userId}`)

      // Redirect back to the frontend with a success flag
      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
      res.writeHead(302, { Location: `${frontendUrl}?calendar=connected` })
      res.end()
    } catch (err) {
      console.error('[calendar] OAuth callback error:', err)
      res.writeHead(500); res.end('OAuth failed')
    }
    return
  }

  // AI summary of tomorrow — GET /summary/tomorrow?token=<jwt>&tz=<iana>
  if (url.pathname === '/summary/tomorrow') {
    // Allow any origin — this is a read-only endpoint guarded by JWT
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders); res.end(); return
    }
    const token = url.searchParams.get('token')
    const tz = url.searchParams.get('tz') ?? undefined
    if (!token) { res.writeHead(400, corsHeaders); res.end('Missing token'); return }
    try {
      const { sub: userId } = await verifyToken(token)
      const ctx = await loadUserContext(userId, tz)

      // Compute tomorrow's date string in user's timezone
      const now = new Date()
      const tomorrowLocalDate = new Date(now.getTime() + 86_400_000)
        .toLocaleDateString('en-CA', { timeZone: ctx.timezone }) // "YYYY-MM-DD"

      const tomorrowLabel = new Date(now.getTime() + 86_400_000).toLocaleDateString('en-US', {
        timeZone: ctx.timezone, weekday: 'long', month: 'long', day: 'numeric',
      })

      const tomorrowEvents = ctx.calendarEvents.filter(e => {
        const eventDate = new Date(e.start).toLocaleDateString('en-CA', { timeZone: ctx.timezone })
        return eventDate === tomorrowLocalDate
      })

      console.log(`[summary] ${userId} — tomorrow ${tomorrowLocalDate} has ${tomorrowEvents.length} events`)

      const summary = await generateTomorrowSummary(tomorrowEvents, tomorrowLabel, ctx.timezone)
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders })
      res.end(JSON.stringify({ summary, tomorrowLabel }))
    } catch (err) {
      console.error('[summary] Error:', err)
      res.writeHead(500, corsHeaders); res.end('Summary failed')
    }
    return
  }

  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: httpServer })

httpServer.listen(PORT, () => {
  console.log(`[voice-server] Listening on http://0.0.0.0:${PORT}`)
})

// ── Connection handler ────────────────────────────────────────────────────────
wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const token = url.searchParams.get('token')
  const browserTz = url.searchParams.get('tz') ?? undefined

  // 1. JWT auth
  if (!token) {
    send(ws, { type: 'error', code: 'missing_token', message: 'No auth token provided' })
    ws.close(1008, 'Missing token')
    return
  }

  let userId: string
  try {
    const payload = await verifyToken(token)
    userId = payload.sub
    console.log(`[auth] Verified user ${userId}`)
  } catch (err) {
    send(ws, { type: 'error', code: 'auth_failed', message: err instanceof Error ? err.message : 'Invalid token' })
    ws.close(1008, 'Auth failed')
    return
  }

  // 2. Rate limit
  if (getUserSessionCount(userId) >= MAX_SESSIONS_PER_USER) {
    send(ws, { type: 'error', code: 'rate_limited', message: 'Too many active sessions' })
    ws.close(1008, 'Rate limited')
    return
  }

  // 3. Load user context
  let context
  try {
    context = await loadUserContext(userId, browserTz)
    console.log(`[context] Loaded for ${context.name}`)
  } catch (err) {
    console.error(`[context] Failed for ${userId}:`, err)
    send(ws, { type: 'error', code: 'context_failed', message: 'Failed to load user data' })
    ws.close(1011, 'Context load failed')
    return
  }

  // 4. Create session
  const sessionId = randomUUID()
  const session = createSession(sessionId, userId, ws, context)

  // 5. Open OpenAI Realtime API connection
  const rt = openRealtimeSession(context, {
    // Agent audio → browser as binary PCM16
    onAudio: (pcm16) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm16, { binary: true })
    },

    // State changes (listening / speaking / idle)
    onStateChange: (state) => {
      session.state = state === 'speaking' ? 'agent_speaking' : state === 'listening' ? 'listening' : 'idle'
      send(ws, { type: 'voice.state', state })
    },

    // Function calls (save_task, mark_done, generate_brief)
    onFunctionCall: (name, args, callId, responseId) => {
      handleFunctionCall(session, rt, name, args, callId, responseId)
    },

    // Transcript — forward to browser for optional display
    onTranscript: (text, role) => {
      send(ws, { type: 'transcript', role, text })
    },

    // Realtime API error
    onError: (msg) => {
      console.error(`[session ${sessionId}] Realtime error: ${msg}`)
      send(ws, { type: 'error', code: 'realtime_error', message: msg })
    },

    // Realtime API closed unexpectedly
    onClose: () => {
      console.log(`[session ${sessionId}] Realtime API closed`)
      send(ws, { type: 'session.ended', reason: 'realtime_closed' })
      ws.close(1000, 'Realtime closed')
    },
  })

  session.rtWs = rt

  // Tell browser the session is ready
  send(ws, {
    type: 'session.created',
    sessionId,
    userId,
    needsTasksReauth: context.needsTasksReauth,
    message: `Connected. Hello, ${context.name}!`,
  })

  // 6. Max session timer
  const maxTimer = setTimeout(() => {
    send(ws, { type: 'session.ended', reason: 'max_duration' })
    ws.close(1000, 'Max session duration')
  }, MAX_SESSION_MS)

  // 7. Message handler
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Audio from browser → relay to OpenAI Realtime API
      if (rt.readyState === WebSocket.OPEN) {
        sendAudioChunk(rt, data as Buffer)
      }
      resetSilenceTimer(sessionId, ws)
    } else {
      try {
        handleControlMessage(sessionId, ws, rt, JSON.parse(data.toString()))
      } catch {
        // ignore malformed JSON
      }
    }
  })

  // 8. Cleanup
  ws.on('close', (code, reason) => {
    clearTimeout(maxTimer)
    clearSilenceTimer(sessionId)
    removeSession(sessionId)
    console.log(`[session] Closed ${sessionId} — code ${code}${reason.length ? ', ' + reason : ''}`)
  })

  ws.on('error', (err) => {
    console.error(`[session ${sessionId}] WS error:`, err.message)
  })
})

// ── Control messages ──────────────────────────────────────────────────────────
function handleControlMessage(
  sessionId: string,
  ws: WebSocket,
  rt: WebSocket,
  msg: Record<string, unknown>
) {
  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong' })
      break

    case 'session.end':
      send(ws, { type: 'session.ended', reason: 'user_ended' })
      ws.close(1000, 'User ended session')
      break

    // Browser requests a morning or night brief — inject a user message into the
    // Realtime API session so the agent responds immediately with the brief.
    case 'brief.request': {
      const briefType = (msg.briefType as string) === 'morning' ? 'morning' : 'night'
      console.log(`[session ${sessionId}] Brief request: ${briefType}`)

      if (rt.readyState !== WebSocket.OPEN) {
        console.warn(`[session ${sessionId}] brief.request ignored — Realtime API not open`)
        break
      }

      const prompt = briefType === 'morning'
        ? 'Please give me my morning brief now. Call generate_brief with type "morning".'
        : 'Please give me my night brief now. Tell me about tomorrow. Call generate_brief with type "night".'

      rt.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      }))
      rt.send(JSON.stringify({ type: 'response.create' }))
      break
    }

    default:
      // Silently ignore unknown types (e.g. task.cancelled from UI)
      break
  }
}

// ── Silence detection ─────────────────────────────────────────────────────────
const silenceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function resetSilenceTimer(sessionId: string, ws: WebSocket) {
  const existing = silenceTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  silenceTimers.set(sessionId, setTimeout(() => {
    send(ws, { type: 'session.ended', reason: 'silence_timeout' })
    ws.close(1000, 'Silence timeout')
    silenceTimers.delete(sessionId)
  }, SILENCE_TIMEOUT_MS))
}

function clearSilenceTimer(sessionId: string) {
  const t = silenceTimers.get(sessionId)
  if (t) { clearTimeout(t); silenceTimers.delete(sessionId) }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}

process.on('SIGTERM', () => {
  console.log('[voice-server] SIGTERM — shutting down')
  httpServer.close(() => wss.close(() => process.exit(0)))
})
