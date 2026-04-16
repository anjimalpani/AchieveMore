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

      const gcalId = await createCalendarEvent(session.userId, title, due_at, notes ?? undefined)
      console.log(`[actions] save_calendar_event "${title}" → gcalId: ${gcalId}`)
      sendFunctionResult(rt, callId, {
        success: !!gcalId,
        gcal_id: gcalId,
        message: gcalId
          ? `Google Calendar event created: "${title}"`
          : 'Failed to create Google Calendar event',
      })

      // Also surface in browser so the user sees it was logged
      if (gcalId) {
        sendBrowser(session.ws, {
          type: 'task.pending_confirmation',
          task: { title, type: 'event', due_at, notes },
          callId,
        })
      }
      break
    }

    case 'mark_done': {
      const taskId = args.task_id as string
      const { error } = await supabase
        .from('tasks')
        .update({ status: 'done' })
        .eq('id', taskId)
        .eq('user_id', session.userId)

      sendFunctionResult(rt, callId, { success: !error, error: error?.message })
      if (!error) sendBrowser(session.ws, { type: 'task.done', taskId })
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

      const gtaskId = await createGoogleTask(session.userId, title, due_at ?? undefined, notes ?? undefined)
      sendFunctionResult(rt, callId, {
        success: !!gtaskId,
        gtask_id: gtaskId,
        message: gtaskId ? `Google Task created: "${title}"` : 'Failed to create Google Task',
      })
      break
    }

    case 'generate_brief': {
      const briefType = args.type as string
      sendFunctionResult(rt, callId, {
        success: true,
        brief: `${briefType === 'morning' ? 'Morning' : 'Night'} brief — full implementation in Phase 6.`,
      })
      break
    }

    default:
      sendFunctionResult(rt, callId, { error: `Unknown function: ${name}` })
  }
}
