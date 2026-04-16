import { WebSocket } from 'ws'
import { createClient } from '@supabase/supabase-js'
import { sendFunctionResult } from './realtime'
import { UserSession } from './session'
import { createCalendarEvent, createGoogleTask } from './calendar'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

function sendBrowser(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}

export async function handleFunctionCall(
  session: UserSession,
  rt: WebSocket,
  name: string,
  args: Record<string, unknown>,
  callId: string,
  responseId: string = ''
): Promise<void> {
  console.log(`[actions] ${name}`, args)

  switch (name) {
    // ── save_task: queue a task for user confirmation, save to Supabase ONLY ──
    // Never creates a Google Calendar event — that is exclusively save_calendar_event's job.
    // Never auto-creates a Google Task — that is save_task_to_google's job.
    case 'save_task': {
      // Mutex: claim this response turn for save_task
      if (responseId) {
        const existing = session.saveCallsByResponse.get(responseId)
        if (existing === 'calendar') {
          console.warn(`[actions] save_task BLOCKED — save_calendar_event already fired for response ${responseId}`)
          sendFunctionResult(rt, callId, { success: false, message: 'Blocked: save_calendar_event already fired for this turn.' })
          break
        }
        session.saveCallsByResponse.set(responseId, 'task')
      }

      const title      = args.title       as string
      const type       = (args.type       as string) ?? 'task'
      const due_at     = (args.due_at     as string) ?? null
      const notes      = (args.notes      as string) ?? null
      const repeat_rule = (args.repeat_rule as string) ?? null

      // Show confirmation card in browser immediately
      sendBrowser(session.ws, {
        type: 'task.pending_confirmation',
        task: { title, type, due_at, notes, repeat_rule },
        callId,
      })

      // Tell agent the task is queued so conversation continues naturally.
      // The actual Supabase INSERT happens when the user taps "Confirm" in the UI —
      // this prevents duplicate rows.
      sendFunctionResult(rt, callId, {
        success: true,
        message: 'Task queued for confirmation in the app. Waiting for user to confirm.',
        title,
        due_at,
      })

      break
    }

    // ── save_calendar_event: create a Google Calendar event ONLY ──
    // Used exclusively when the user says explicit scheduling language:
    // "schedule a meeting", "book a call", "add to my calendar", etc.
    // Does NOT save to the Supabase tasks table.
    case 'save_calendar_event': {
      // Mutex: if save_task already fired in this response turn, block this call
      if (responseId) {
        const existing = session.saveCallsByResponse.get(responseId)
        if (existing === 'task') {
          console.warn(`[actions] save_calendar_event BLOCKED — save_task already fired for response ${responseId}`)
          sendFunctionResult(rt, callId, { success: false, message: 'Blocked: save_task already fired for this turn.' })
          break
        }
        session.saveCallsByResponse.set(responseId, 'calendar')
      }

      const title  = args.title  as string
      const due_at = args.due_at as string
      const notes  = (args.notes as string) ?? null

      if (!session.context.hasCalendar) {
        sendFunctionResult(rt, callId, {
          success: false,
          message: 'Google Calendar not connected. Ask the user to connect it first.',
        })
        break
      }

      if (!due_at) {
        sendFunctionResult(rt, callId, {
          success: false,
          message: 'due_at is required for a calendar event. Ask the user for the date/time.',
        })
        break
      }

      try {
        const gcalId = await createCalendarEvent(session.userId, title, due_at, notes ?? undefined)
        console.log(`[actions] save_calendar_event "${title}" → gcalId: ${gcalId}`)
        sendFunctionResult(rt, callId, {
          success: !!gcalId,
          gcal_id: gcalId,
          message: gcalId
            ? `Google Calendar event created: "${title}"`
            : 'Failed to create Google Calendar event',
        })
        if (gcalId) {
          sendBrowser(session.ws, {
            type: 'task.pending_confirmation',
            task: { title, type: 'event', due_at, notes },
            callId,
          })
        }
      } catch (err) {
        console.error('[actions] save_calendar_event error:', err)
        sendFunctionResult(rt, callId, { success: false, message: 'Server error creating calendar event.' })
      }
      break
    }

    case 'mark_done': {
      const taskId = args.task_id as string
      try {
        const { error } = await supabase
          .from('tasks')
          .update({ status: 'done' })
          .eq('id', taskId)
          .eq('user_id', session.userId)
        if (error) throw error
        sendFunctionResult(rt, callId, { success: true })
        sendBrowser(session.ws, { type: 'task.done', taskId })
      } catch (err) {
        console.error('[actions] mark_done error:', err)
        sendFunctionResult(rt, callId, { success: false, message: 'Failed to mark task done.' })
      }
      break
    }

    case 'save_task_to_google': {
      const title  = args.title  as string
      const due_at = (args.due_at as string) ?? null
      const notes  = (args.notes  as string) ?? null

      if (!session.context.hasCalendar) {
        sendFunctionResult(rt, callId, {
          success: false,
          message: 'Google account not connected. Ask the user to connect Google Calendar/Tasks first.',
        })
        break
      }

      try {
        const gtaskId = await createGoogleTask(session.userId, title, due_at ?? undefined, notes ?? undefined)
        sendFunctionResult(rt, callId, {
          success: !!gtaskId,
          gtask_id: gtaskId,
          message: gtaskId ? `Google Task created: "${title}"` : 'Failed to create Google Task',
        })
      } catch (err) {
        console.error('[actions] save_task_to_google error:', err)
        sendFunctionResult(rt, callId, { success: false, message: 'Failed to create Google Task.' })
      }
      break
    }

    case 'generate_brief': {
      const briefType = (args.type as string) === 'morning' ? 'morning' : 'night'
      const ctx = session.context

      try {
        let events: { time: string; title: string }[]
        let dateLabel: string

        if (briefType === 'morning') {
          events = ctx.todayEvents
          dateLabel = ctx.today
        } else {
          // Night brief — use tomorrow's calendar events
          const now = new Date()
          const tomorrowDate = new Date(now)
          tomorrowDate.setDate(tomorrowDate.getDate() + 1)
          const tomorrowDateStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: ctx.timezone })

          const tomorrowCalEvents = ctx.calendarEvents.filter(e => {
            const eventDate = new Date(e.start).toLocaleDateString('en-CA', { timeZone: ctx.timezone })
            return eventDate === tomorrowDateStr
          })

          dateLabel = tomorrowDate.toLocaleDateString('en-US', {
            timeZone: ctx.timezone, weekday: 'long', month: 'long', day: 'numeric',
          })

          events = tomorrowCalEvents.map(e => ({
            time: e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString('en-US', {
              timeZone: ctx.timezone, hour: 'numeric', minute: '2-digit',
            }),
            title: e.title,
          }))
        }

        const upcomingTasks = ctx.upcomingTasks.slice(0, 5)
        const briefSummary = events.length === 0
          ? `No events scheduled for ${dateLabel}.`
          : events.map(e => `${e.time}: ${e.title}`).join(' | ')

        // Save brief to database
        await supabase.from('briefs').insert({
          user_id: session.userId,
          type: briefType,
          content: briefSummary,
        })

        console.log(`[actions] generate_brief "${briefType}" for ${session.userId} — ${events.length} events`)

        sendFunctionResult(rt, callId, {
          success: true,
          brief_type: briefType,
          date: dateLabel,
          events,
          event_count: events.length,
          upcoming_tasks: upcomingTasks,
          has_events: events.length > 0,
        })
      } catch (err) {
        console.error('[actions] generate_brief error:', err)
        sendFunctionResult(rt, callId, { success: false, message: 'Failed to load brief data.' })
      }
      break
    }

    default:
      sendFunctionResult(rt, callId, { error: `Unknown function: ${name}` })
  }
}
