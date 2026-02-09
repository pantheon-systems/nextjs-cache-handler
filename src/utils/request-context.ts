import { AsyncLocalStorage } from 'async_hooks';
import { createLogger } from './logger.js';

const log = createLogger('RequestContext');

interface RequestContextData {
  tags: string[];
  startTime: number;
}

/**
 * Request-scoped context for tracking cache tags during SSR.
 * Uses AsyncLocalStorage to maintain isolation between concurrent requests.
 */
export class RequestContext {
  private static storage = new AsyncLocalStorage<RequestContextData>();

  /**
   * Add tags to the current request context.
   * Called by cache handler during cache hits.
   */
  static addTags(tags: string[]): void {
    const context = this.storage.getStore();
    if (context) {
      context.tags.push(...tags);
      log.debug(`Added ${tags.length} tags to request context: ${tags.join(', ')}`);
    } else {
      log.warn('No request context available - tags will not be captured');
    }
  }

  /**
   * Get all unique tags accumulated during the current request.
   * Called by middleware before sending response.
   */
  static getTags(): string[] {
    const context = this.storage.getStore();
    if (!context) {
      return [];
    }
    // Remove duplicates using Set
    return [...new Set(context.tags)];
  }

  /**
   * Run a callback within a request context.
   * Must be called by middleware to initialize tracking.
   */
  static run<T>(callback: () => T): T {
    return this.storage.run(
      {
        tags: [],
        startTime: Date.now(),
      },
      callback
    );
  }

  /**
   * Check if running within a request context.
   * Useful for debugging and conditional logic.
   */
  static isActive(): boolean {
    return this.storage.getStore() !== undefined;
  }
}
