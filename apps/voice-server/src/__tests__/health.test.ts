/**
 * Tests for the /health response builder.
 * Imports from health.ts (not index.ts) so no HTTP server is started.
 */

// Mock session module so getSessionCount() doesn't need real sessions
jest.mock('../session', () => ({
  getSessionCount: jest.fn(() => 0),
  getUserSessionCount: jest.fn(() => 0),
  createSession: jest.fn(),
  getSession: jest.fn(),
  removeSession: jest.fn(),
}))

const originalEnv = process.env

beforeEach(() => {
  process.env = { ...originalEnv }
  jest.resetModules()
})

afterAll(() => {
  process.env = originalEnv
})

async function importHealth() {
  jest.resetModules()
  // Re-mock session after resetModules
  jest.mock('../session', () => ({ getSessionCount: jest.fn(() => 0) }))
  const { buildHealthResponse } = await import('../health')
  return buildHealthResponse
}

describe('buildHealthResponse', () => {
  it('returns status "ok" when all required env vars are set', async () => {
    process.env.OPENAI_API_KEY    = 'sk-test'
    process.env.SUPABASE_URL      = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-key'

    const buildHealthResponse = await importHealth()
    expect(buildHealthResponse().status).toBe('ok')
  })

  it('returns status "degraded" when OPENAI_API_KEY is missing', async () => {
    process.env.SUPABASE_URL         = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-key'
    delete process.env.OPENAI_API_KEY

    const buildHealthResponse = await importHealth()
    const result = buildHealthResponse()
    expect(result.status).toBe('degraded')
    expect(result.env.openai).toBe(false)
  })

  it('returns status "degraded" when SUPABASE_URL is missing', async () => {
    process.env.OPENAI_API_KEY       = 'sk-test'
    process.env.SUPABASE_SERVICE_KEY = 'service-key'
    delete process.env.SUPABASE_URL

    const buildHealthResponse = await importHealth()
    const result = buildHealthResponse()
    expect(result.status).toBe('degraded')
    expect(result.env.supabase).toBe(false)
  })

  it('includes sessions count, uptime seconds, and version', async () => {
    process.env.OPENAI_API_KEY       = 'sk-test'
    process.env.SUPABASE_URL         = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-key'

    const buildHealthResponse = await importHealth()
    const result = buildHealthResponse()

    expect(typeof result.sessions).toBe('number')
    expect(result.sessions).toBeGreaterThanOrEqual(0)
    expect(typeof result.uptime).toBe('number')
    expect(result.uptime).toBeGreaterThanOrEqual(0)
    expect(result.version).toBe('1.0.0')
  })

  it('env object reports all three keys correctly', async () => {
    process.env.OPENAI_API_KEY       = 'sk-test'
    process.env.SUPABASE_URL         = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-key'

    const buildHealthResponse = await importHealth()
    expect(buildHealthResponse().env).toEqual({
      openai:      true,
      supabase:    true,
      supabaseKey: true,
    })
  })

  it('responds synchronously (under 2 seconds)', async () => {
    const buildHealthResponse = await importHealth()
    const start = Date.now()
    buildHealthResponse()
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
