'use client'

export type OrbState = 'idle' | 'listening' | 'speaking' | 'processing'

interface VoiceOrbProps {
  state: OrbState
}

export default function VoiceOrb({ state }: VoiceOrbProps) {
  return (
    <div className="flex items-center justify-center" aria-label={`Voice state: ${state}`}>
      <div className="relative flex items-center justify-center w-16 h-16">
        {/* Outer rings — listening only */}
        {state === 'listening' && (
          <>
            <span className="absolute inline-flex w-full h-full rounded-full bg-red-500 opacity-40 animate-ping" />
            <span className="absolute inline-flex w-3/4 h-3/4 rounded-full bg-red-500 opacity-30 animate-ping [animation-delay:150ms]" />
          </>
        )}

        {/* Speaking pulse rings */}
        {state === 'speaking' && (
          <>
            <span className="absolute inline-flex w-full h-full rounded-full bg-indigo-400 opacity-30 animate-ping [animation-duration:800ms]" />
            <span className="absolute inline-flex w-5/6 h-5/6 rounded-full bg-indigo-400 opacity-25 animate-ping [animation-duration:1100ms] [animation-delay:200ms]" />
          </>
        )}

        {/* Core orb */}
        <div
          className={[
            'relative z-10 w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all duration-300',
            state === 'idle'       && 'bg-gray-700',
            state === 'listening'  && 'bg-red-500 scale-110',
            state === 'speaking'   && 'bg-indigo-500 animate-pulse',
            state === 'processing' && 'bg-yellow-500',
          ].filter(Boolean).join(' ')}
        >
          {state === 'idle'       && <span className="text-xl">🎙</span>}
          {state === 'listening'  && <span className="text-xl text-white">🎙</span>}
          {state === 'speaking'   && <span className="text-xl text-white">🔊</span>}
          {state === 'processing' && (
            <svg className="animate-spin w-5 h-5 text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
            </svg>
          )}
        </div>
      </div>
    </div>
  )
}
