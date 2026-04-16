import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock the openai module before importing summary ───────────────────────────
// vi.mock is hoisted — cannot reference variables defined outside the factory
vi.mock('openai', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    choices: [{
      message: {
        content: 'You have a fairly busy day tomorrow with a team standup at 9:00 AM and a product review at 2:00 PM. Make sure to prep your notes ahead of the product review — it starts right after lunch.',
      },
    }],
  })
  // Must be a constructible function for `new OpenAI(...)` to work
  function MockOpenAI() {
    return { chat: { completions: { create: mockCreate } } }
  }
  return { default: MockOpenAI }
})

import { generateTomorrowSummary } from './summary'
import type { CalendarEvent } from './calendar'

const TOMORROW_LABEL = 'Wednesday, April 16'
const TIMEZONE = 'America/New_York'

const TWO_EVENTS: CalendarEvent[] = [
  {
    id: 'evt-1',
    title: 'Team Standup',
    start: '2025-04-16T09:00:00-04:00',
    end:   '2025-04-16T09:30:00-04:00',
    allDay: false,
  },
  {
    id: 'evt-2',
    title: 'Product Review',
    start: '2025-04-16T14:00:00-04:00',
    end:   '2025-04-16T15:00:00-04:00',
    allDay: false,
  },
]

describe('generateTomorrowSummary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a non-empty string for a user with 2 events tomorrow', async () => {
    const result = await generateTomorrowSummary(TWO_EVENTS, TOMORROW_LABEL, TIMEZONE)

    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(20)
  })

  it('mentions at least one event detail from the calendar', async () => {
    const result = await generateTomorrowSummary(TWO_EVENTS, TOMORROW_LABEL, TIMEZONE) as string

    const lower = result.toLowerCase()
    const mentionsEvent =
      lower.includes('standup') ||
      lower.includes('product') ||
      lower.includes('review') ||
      lower.includes('9') ||
      lower.includes('2:00') ||
      lower.includes('2 pm') ||
      lower.includes('lunch')

    expect(mentionsEvent).toBe(true)
  })

  it('returns null for an empty events list', async () => {
    const result = await generateTomorrowSummary([], TOMORROW_LABEL, TIMEZONE)
    expect(result).toBeNull()
  })

  it('handles all-day events without crashing', async () => {
    const allDayEvents: CalendarEvent[] = [{
      id: 'evt-all',
      title: 'Company Holiday',
      start: '2025-04-16',
      end:   '2025-04-17',
      allDay: true,
    }]

    const result = await generateTomorrowSummary(allDayEvents, TOMORROW_LABEL, TIMEZONE)
    expect(result).toBeTruthy()
  })
})
