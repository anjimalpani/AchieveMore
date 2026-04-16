import { WebSocket } from 'ws'
import { UserContext } from './context'

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview'

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    name: 'save_task',
    description: 'Save a task or reminder to the user\'s AchieveMore list after they confirm it. Use this for anything the user needs TO DO: reminders, errands, personal tasks, work todos — even if they have a specific time. This saves to the app ONLY, not to Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        title:        { type: 'string', description: 'Task title' },
        type:         { type: 'string', enum: ['task', 'reminder'], description: 'task or reminder' },
        due_at:       { type: 'string', description: 'ISO 8601 datetime with UTC offset, e.g. 2025-04-18T14:00:00-04:00' },
        notes:        { type: 'string', description: 'Any prep notes or context' },
        repeat_rule:  { type: 'string', description: 'iCal RRULE string if recurring' },
      },
      required: ['title', 'type'],
    },
  },
  {
    type: 'function',
    name: 'save_calendar_event',
    description: 'Create an event in the user\'s Google Calendar. Use this ONLY when the user explicitly uses scheduling language: "schedule a meeting", "book a call", "add to my calendar", "set up a video call", "put it in my calendar". This saves to Google Calendar ONLY — do NOT also call save_task for the same item.',
    parameters: {
      type: 'object',
      properties: {
        title:  { type: 'string', description: 'Event title' },
        due_at: { type: 'string', description: 'ISO 8601 datetime with UTC offset — required' },
        notes:  { type: 'string', description: 'Event description or notes' },
      },
      required: ['title', 'due_at'],
    },
  },
  {
    type: 'function',
    name: 'save_task_to_google',
    description: 'Sync a task to the user\'s Google Tasks list. Call this only after save_task succeeds, if the user also wants it in Google Tasks.',
    parameters: {
      type: 'object',
      properties: {
        title:  { type: 'string', description: 'Task title' },
        due_at: { type: 'string', description: 'ISO 8601 datetime for the due date' },
        notes:  { type: 'string', description: 'Optional notes or context' },
      },
      required: ['title'],
    },
  },
  {
    type: 'function',
    name: 'mark_done',
    description: 'Mark a task as completed',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'generate_brief',
    description: 'Generate a morning or night brief from the user\'s schedule',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['morning', 'night'] } },
      required: ['type'],
    },
  },
]

// ── System prompt (from CLAUDE.md template) ───────────────────────────────────
export function buildSystemPrompt(ctx: UserContext): string {
  return `You are a personal day-prep assistant for ${ctx.name}. You help them manage tasks, prepare for their day, and stay organised. You speak in a warm, concise, natural tone — like a helpful colleague, not a robot.

TODAY IS: ${ctx.today}
USER TIMEZONE: ${ctx.timezone} (UTC${ctx.utcOffset})
WAKE TIME: ${ctx.wakeTime} | PREFERRED BRIEF STYLE: ${ctx.briefStyle}

TODAY'S SCHEDULE:
${ctx.todayEvents.map(e => `- ${e.time}: ${e.title}`).join('\n') || 'No events yet'}

UPCOMING TASKS (AchieveMore):
${ctx.upcomingTasks.map(t => `- ${t.dueAt}: ${t.title} [${t.type}]`).join('\n') || 'No tasks'}

GOOGLE TASKS (existing, from Google Tasks app):
${ctx.googleTasks.length > 0
  ? ctx.googleTasks.map(t => `- ${t.due ? new Date(t.due).toLocaleDateString('en-US', { timeZone: ctx.timezone, weekday: 'short', month: 'short', day: 'numeric' }) : 'No date'}: ${t.title}${t.notes ? ` (${t.notes})` : ''}`).join('\n')
  : ctx.hasCalendar ? 'No pending Google Tasks' : 'Google Tasks not connected'
}

TIMEZONE RULES — CRITICAL:
- The user is in ${ctx.timezone} (currently UTC${ctx.utcOffset}).
- When you call save_task, the due_at field MUST be a full ISO 8601 string with the correct UTC offset for this timezone.
- Example: if the user says "2pm tomorrow" and timezone is UTC${ctx.utcOffset}, set due_at to "YYYY-MM-DDT14:00:00${ctx.utcOffset}" (the next calendar day in their timezone).
- NEVER output a bare UTC "Z" timestamp unless the user explicitly says UTC.
- Always double-check the day is correct in the user's timezone before confirming.

TASK vs CALENDAR EVENT — CRITICAL RULES:
- Use save_task for: reminders, todos, errands, personal tasks, work items — anything the user needs TO DO, even if it has a specific time ("remind me to call mum at 3pm" → save_task)
- Use save_calendar_event for: ONLY when the user explicitly uses scheduling words like "schedule", "book", "add to my calendar", "set up a meeting/call" — these go to Google Calendar ONLY
- NEVER call both save_task and save_calendar_event for the same item — they are mutually exclusive
- NEVER call save_task for a calendar event, and NEVER call save_calendar_event for a regular task
- IMPORTANT: Having a specific time does NOT make something a calendar event. Examples:
  - "add gym tomorrow at 7am" → save_task (NOT save_calendar_event)
  - "remind me to take meds at 9pm" → save_task
  - "schedule a meeting with John on Friday at 2pm" → save_calendar_event (explicit scheduling word)
  - "book a call with the team tomorrow" → save_calendar_event
  - "add dentist appointment to my calendar" → save_calendar_event (explicit "add to calendar")

BEHAVIOUR RULES:
- Keep responses short (1-2 sentences max) unless doing a full brief.
- SAVE TASKS IMMEDIATELY — the moment a user mentions a task, call save_task right away. Do NOT ask "does that sound right?" The app shows a confirmation card so they review it there. Just say "Got it, I've queued that up." in one brief sentence.
- If the date/time is genuinely ambiguous (e.g. "remind me later"), ask once: "When do you need this done?"
- For briefs, always call generate_brief — do NOT try to speak the schedule from memory. The function returns the real data.
- For morning/night briefs, call generate_brief then speak the result in a warm, structured way: list items in time order, flag anything needing prep.
- You can be interrupted — stop speaking immediately if the user starts talking.
- If the user already has a matching Google Task, mention it rather than creating a duplicate.
- Never mention that you're an AI unless directly asked.`
}

// ── Event handler interface ───────────────────────────────────────────────────
export interface RTHandlers {
  onAudio: (pcm16: Buffer) => void
  onStateChange: (state: 'idle' | 'listening' | 'speaking') => void
  onFunctionCall: (name: string, args: Record<string, unknown>, callId: string, responseId: string) => void
  onTranscript: (text: string, role: 'user' | 'assistant') => void
  onError: (msg: string) => void
  onClose: () => void
}

// ── Open a Realtime API session ───────────────────────────────────────────────
export function openRealtimeSession(ctx: UserContext, handlers: RTHandlers): WebSocket {
  const rt = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  })

  rt.on('open', () => {
    console.log('[realtime] Connected to OpenAI Realtime API')
    rt.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: buildSystemPrompt(ctx),
        voice: ctx.voiceId,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.8,
        max_response_output_tokens: 1024,
      },
    }))
  })

  rt.on('message', (raw) => {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }

    const type = event.type as string

    switch (type) {
      case 'session.created':
      case 'session.updated':
        console.log(`[realtime] ${type}`)
        break

      // VAD: user started speaking → agent should stop if it was mid-response
      case 'input_audio_buffer.speech_started':
        handlers.onStateChange('listening')
        break

      // Response lifecycle
      case 'response.created':
        handlers.onStateChange('speaking')
        break

      case 'response.audio.delta': {
        const delta = event.delta as string | undefined
        if (delta) handlers.onAudio(Buffer.from(delta, 'base64'))
        break
      }

      case 'response.done':
        handlers.onStateChange('idle')
        break

      // Transcripts (informational — forwarded to browser for display)
      case 'conversation.item.input_audio_transcription.completed':
        handlers.onTranscript((event.transcript as string) ?? '', 'user')
        break

      case 'response.text.delta':
        // partial text — ignore for audio-only flow
        break

      // Function calls
      case 'response.function_call_arguments.done': {
        const name = event.name as string
        const callId = event.call_id as string
        const responseId = (event.response_id as string) ?? ''
        try {
          const args = JSON.parse(event.arguments as string) as Record<string, unknown>
          handlers.onFunctionCall(name, args, callId, responseId)
        } catch {
          handlers.onError(`Malformed function call args for ${name}`)
        }
        break
      }

      case 'error': {
        const err = event.error as { message?: string } | undefined
        console.error('[realtime] Error event:', event)
        handlers.onError(err?.message ?? 'Unknown Realtime API error')
        break
      }

      default:
        // Silently ignore other event types (rate_limits, etc.)
        break
    }
  })

  rt.on('close', (code, reason) => {
    console.log(`[realtime] Closed — code ${code}, reason: ${reason.toString() || 'none'}`)
    handlers.onClose()
  })

  rt.on('error', (err) => {
    console.error('[realtime] WebSocket error:', err.message)
    handlers.onError(err.message)
  })

  return rt
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Forward a PCM16 binary buffer as a base64 audio append event */
export function sendAudioChunk(rt: WebSocket, pcm16: Buffer): void {
  if (rt.readyState !== WebSocket.OPEN) return
  rt.send(JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: pcm16.toString('base64'),
  }))
}

/** Send a function call result and trigger the next response turn */
export function sendFunctionResult(rt: WebSocket, callId: string, result: unknown): void {
  if (rt.readyState !== WebSocket.OPEN) return
  rt.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(result),
    },
  }))
  rt.send(JSON.stringify({ type: 'response.create' }))
}
