/**
 * Logger whose debug and info output appears only with CACHE_DEBUG=true or 1,
 * so verbose logs stay out of production; warn and error always appear.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function isDebugEnabled(): boolean {
  const debugValue = process.env.CACHE_DEBUG;
  return debugValue === 'true' || debugValue === '1';
}

function formatMessage(handlerName: string, message: string): string {
  return `[${handlerName}] ${message}`;
}

/**
 * Creates a logger instance for a specific handler.
 * Debug and info logs are only shown when CACHE_DEBUG is true or 1.
 * Warn and error logs are always shown.
 */
export function createLogger(handlerName: string) {
  return {
    /**
     * Debug level - only shown when CACHE_DEBUG is true or 1
     * Use for verbose operational logs (GET, SET, HIT, MISS, etc.)
     */
    debug: (message: string, ...args: unknown[]) => {
      if (isDebugEnabled()) {
        console.log(formatMessage(handlerName, message), ...args);
      }
    },

    /**
     * Info level - only shown when CACHE_DEBUG is true or 1
     * Use for important operational events (initialization, cache cleared, etc.)
     */
    info: (message: string, ...args: unknown[]) => {
      if (isDebugEnabled()) {
        console.log(formatMessage(handlerName, message), ...args);
      }
    },

    /**
     * Warn level - always shown
     * Use for recoverable issues that might need attention
     */
    warn: (message: string, ...args: unknown[]) => {
      console.warn(formatMessage(handlerName, message), ...args);
    },

    /**
     * Error level - always shown
     * Use for errors that affect cache operations
     */
    error: (message: string, ...args: unknown[]) => {
      console.error(formatMessage(handlerName, message), ...args);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * A list for a log line: the first few values and how many were left out.
 * A purge can name tens of thousands of paths, and the line is built even when
 * debug logging is off.
 */
export function summarizeList(values: string[], show: number = 10): string {
  if (values.length <= show) {
    return values.join(', ');
  }
  return `${values.slice(0, show).join(', ')} and ${values.length - show} more`;
}
