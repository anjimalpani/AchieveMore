'use client'

import { useEffect, useState } from 'react'

interface SummaryData {
  summary: string | null
  tomorrowLabel: string
}

type State = 'idle' | 'loading' | 'loaded' | 'no-calendar' | 'error'

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export default function TomorrowSummary({ userTimezone }: { userTimezone: string }) {
  const [state, setState] = useState<State>('idle')
  const [data, setData] = useState<SummaryData | null>(null)

  useEffect(() => {
    async function load() {
      const cacheKey = `tomorrow_summary_v2`
      const cached = typeof window !== 'undefined' ? localStorage.getItem(cacheKey) : null
      if (cached) {
        try {
          const { ts, payload } = JSON.parse(cached)
          if (Date.now() - ts < CACHE_TTL_MS) {
            setData(payload)
            setState('loaded')
            return
          }
        } catch {
          // stale/corrupt — refetch
        }
      }

      setState('loading')
      try {
        const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || userTimezone)
        const res = await fetch(`/api/calendar/tomorrow?tz=${tz}`)

        if (res.status === 404) {
          setState('no-calendar')
          return
        }
        if (!res.ok) {
          console.error('[TomorrowSummary] Server responded', res.status, await res.text())
          setState('error')
          return
        }

        const payload: SummaryData = await res.json()
        setData(payload)
        setState('loaded')

        if (typeof window !== 'undefined') {
          localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), payload }))
        }
      } catch (err) {
        console.error('[TomorrowSummary] Fetch failed:', err)
        setState('error')
      }
    }

    load()
  }, [userTimezone])

  // Don't render anything if calendar isn't connected
  if (state === 'no-calendar' || state === 'idle') return null

  return (
    <div className="rounded-2xl border border-white/20 bg-white/10 backdrop-blur-md p-4 shadow-lg">
      <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-2">
        {data?.tomorrowLabel ?? 'Tomorrow'}
      </h3>

      {state === 'loading' && (
        <div className="space-y-2 animate-pulse">
          <div className="h-3 bg-white/20 rounded w-full" />
          <div className="h-3 bg-white/20 rounded w-4/5" />
          <div className="h-3 bg-white/20 rounded w-3/5" />
        </div>
      )}

      {state === 'loaded' && data?.summary && (
        <p className="text-sm text-white/90 leading-relaxed">{data.summary}</p>
      )}

      {state === 'loaded' && data && !data.summary && (
        <p className="text-sm text-white/50 italic">Nothing on the calendar tomorrow &mdash; a clear day.</p>
      )}

      {state === 'error' && (
        <p className="text-sm text-white/40 italic">Could not load tomorrow&apos;s summary.</p>
      )}
    </div>
  )
}
