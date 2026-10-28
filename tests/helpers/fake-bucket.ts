/**
 * In-memory stand-in for a GCS bucket with per-object generations and
 * `ifGenerationMatch` preconditions, the semantics the tag map and the shared
 * revalidations rely on.
 */
export class FakeBucket {
  readonly name = 'test-bucket';
  readonly objects = new Map<string, { data: string; generation: number; custom?: Record<string, string> }>();
  private nextGeneration = 1;
  /** Fail the next N writes to a key with this status code. */
  readonly failWrites = new Map<string, { code: number; times: number }>();
  /** Successful writes per key. */
  readonly writes = new Map<string, number>();

  file(name: string, options?: { generation?: string | number }) {
    const error = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });
    const objects = this.objects;
    return {
      name,
      /** As a listing returns it: the object generation and custom metadata. */
      get metadata() {
        const object = objects.get(name);
        return object ? { generation: String(object.generation), metadata: object.custom } : undefined;
      },
      exists: async () => [this.objects.has(name)] as [boolean],
      getMetadata: async () => {
        const object = this.objects.get(name);
        if (!object) throw error(404);
        return [{ generation: String(object.generation) }];
      },
      download: async () => {
        const object = this.objects.get(name);
        if (
          !object ||
          (options?.generation !== undefined && String(object.generation) !== String(options.generation))
        ) {
          throw error(404);
        }
        return [Buffer.from(object.data)] as [Buffer];
      },
      save: async (
        data: string,
        saveOptions?: {
          preconditionOpts?: { ifGenerationMatch?: string | number };
          metadata?: { metadata?: Record<string, string> };
        }
      ) => {
        const failure = this.failWrites.get(name);
        if (failure && failure.times > 0) {
          failure.times--;
          throw error(failure.code);
        }
        const expected = saveOptions?.preconditionOpts?.ifGenerationMatch;
        if (expected !== undefined) {
          const current = this.objects.get(name)?.generation ?? 0;
          if (String(current) !== String(expected)) throw error(412);
        }
        this.objects.set(name, { data, generation: this.nextGeneration++, custom: saveOptions?.metadata?.metadata });
        this.writes.set(name, (this.writes.get(name) ?? 0) + 1);
      },
      delete: async (deleteOptions?: { ifGenerationMatch?: string | number }) => {
        const expected = deleteOptions?.ifGenerationMatch;
        if (expected !== undefined) {
          const object = this.objects.get(name);
          if (!object) throw error(404);
          if (String(object.generation) !== String(expected)) throw error(412);
        }
        this.objects.delete(name);
      },
    };
  }

  async getFiles({ prefix }: { prefix: string }) {
    return [[...this.objects.keys()].filter((name) => name.startsWith(prefix)).map((name) => this.file(name))];
  }

  json(name: string): unknown {
    const object = this.objects.get(name);
    return object ? JSON.parse(object.data) : undefined;
  }

  putJson(name: string, value: unknown, custom?: Record<string, string>): void {
    this.objects.set(name, { data: JSON.stringify(value), generation: this.nextGeneration++, custom });
  }
}
