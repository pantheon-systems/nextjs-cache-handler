module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['**/integration/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testTimeout: 60000, // 60 seconds for integration tests
  transform: {
    '^.+\\.(t|j)sx?$': '@swc/jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  collectCoverageFrom: [
    'integration/**/*.{ts,tsx}',
    '!integration/**/*.d.ts',
  ],
}