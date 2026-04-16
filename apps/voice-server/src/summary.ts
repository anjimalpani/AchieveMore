import OpenAI from 'openai'
import type { CalendarEvent } from './calendar'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/**
 * Generates a 2-3 sentence warm summary of tomorrow's calendar events.
 * Returns null if there are no events.
 */
export async function generateTomorrowSummary(
  events: CalendarEvent[],
  tomorrowLabel: string,
  timezone: string
): Promise<string | null> {
  if (events.length === 0) return null

  const eventList = events.map(e => {
    const time = e.allDay
      ? 'All day'
      : new Date(e.start).toLocaleTimeString('en-US', {
          timeZone: timezone, hour: 'numeric', minute: '2-digit',
        })
    return `- ${time}: ${e.title}`
  }).join('\n')

  console.log(`[summary] Generating summary for ${tomorrowLabel} — ${events.length} events:\n${eventList}`)

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 120,
    messages: [
      {
        role: 'system',
        content: 'You are a concise personal assistant. Given a list of calendar events for tomorrow, write a 2-3 sentence warm, friendly summary. Focus on what the day looks like — busy vs light, any key events to prepare for. No bullet points. Write in second-person "you have..." style.',
      },
      {
        role: 'user',
        content: `Tomorrow is ${tomorrowLabel}.\n\nEvents:\n${eventList}`,
      },
    ],
  })

  const result = completion.choices[0]?.message?.content?.trim() ?? null
  console.log(`[summary] Result: ${result}`)
  return result
}
