import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Run both the original summary tests and the new __tests__ suite
  testMatch: ['**/__tests__/**/*.test.ts', '**/src/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/__tests__/**',
  ],
  coverageReporters: ['text', 'lcov'],
  // Silence noisy console output during test runs
  silent: false,
  // Each test file gets a fresh module registry — important for mocked env vars
  resetModules: true,
}

export default config
