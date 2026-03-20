import { describe, it, expect, afterEach } from 'vitest';
import { getEnvironmentPrefix } from '../../src/utils/environment-prefix.js';

describe('getEnvironmentPrefix', () => {
  afterEach(() => {
    delete process.env.PANTHEON_ENVIRONMENT;
  });

  it('should return empty string when PANTHEON_ENVIRONMENT is not set', () => {
    delete process.env.PANTHEON_ENVIRONMENT;
    expect(getEnvironmentPrefix()).toBe('');
  });

  it('should return empty string for live (production) environment', () => {
    process.env.PANTHEON_ENVIRONMENT = 'live';
    expect(getEnvironmentPrefix()).toBe('');
  });

  it('should return prefixed path for dev environment', () => {
    process.env.PANTHEON_ENVIRONMENT = 'dev';
    expect(getEnvironmentPrefix()).toBe('environments/dev/');
  });

  it('should return prefixed path for multidev PR environment', () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-123';
    expect(getEnvironmentPrefix()).toBe('environments/pr-123/');
  });

  it('should return prefixed path for named multidev environment', () => {
    process.env.PANTHEON_ENVIRONMENT = 'feature-xyz';
    expect(getEnvironmentPrefix()).toBe('environments/feature-xyz/');
  });
});
