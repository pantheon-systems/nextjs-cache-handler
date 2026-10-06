/**
 * In-memory stand-in for a GCS bucket with per-object generations and
 * `ifGenerationMatch` preconditions, the semantics the tag map and the shared
 * revalidations rely on.
 */
export class FakeBucket {
  readonly objects = new Map<string, { data: string; generation: number }>();
  private nextGeneration = 1;
  /** Fail the next N writes to a key with this status code. */
  readonly failWrites = new Map<string, { code: number; times: number }>();
  /** Successful writes per key. */
  readonly writes = new Map<string, number>();

  file(name: string, options?: { generation?: string | number }) {
    const error = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });
    return {
      name,
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
      save: async (data: string, saveOptions?: { preconditionOpts?: { ifGenerationMatch?: string | number } }) => {
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
        this.objects.set(name, { data, generation: this.nextGeneration++ });
        this.writes.set(name, (this.writes.get(name) ?? 0) + 1);
      },
      delete: async () => {
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

  putJson(name: string, value: unknown): void {
    this.objects.set(name, { data: JSON.stringify(value), generation: this.nextGeneration++ });
  }
}
