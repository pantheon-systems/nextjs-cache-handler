// Runs example/integration, the suite the Next.js 16 example runs, against this
// Next.js 15 app. process.cwd() is this directory, so the suite builds, starts
// and inspects the .next/cache of this app.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/../../example/integration'],
  setupFilesAfterEnv: ['<rootDir>/../../example/jest.setup.js'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 60000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js'],
}
