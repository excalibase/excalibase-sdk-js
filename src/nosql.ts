/**
 * NoSQL document collection API.
 * Communicates with /api/v1/nosql/* REST endpoints.
 */

export interface CollectionDef {
  fields: Record<string, string>;
  indexes: IndexDef[];
  search?: string;
  vector?: { field: string; dimensions: number };
}

export interface IndexDef {
  fields: string[];
  type?: string;
  unique?: boolean;
}

export interface SchemaDeclaration {
  collections: Record<string, CollectionDef>;
}

export interface FindOptions {
  limit?: number;
  offset?: number;
  sort?: Record<string, 1 | -1>;
  allowScan?: boolean;
}

export interface UpdateOp {
  $set?: Record<string, unknown>;
}

export interface UpdateResult {
  matched: number;
  modified: number;
}

export interface DeleteResult {
  deleted: number;
}

export function defineSchema(collections: Record<string, CollectionDef>): SchemaDeclaration {
  return { collections };
}

export function defineCollection(opts: CollectionDef): CollectionDef {
  return opts;
}

export class CollectionClient {
  private readonly baseUrl: string;
  private readonly collection: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, collection: string, fetchFn: typeof fetch, headers: Record<string, string>) {
    this.baseUrl = baseUrl;
    this.collection = collection;
    this.fetchFn = fetchFn;
    this.headers = headers;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = path ? `${this.baseUrl}/${this.collection}${path}` : `${this.baseUrl}/${this.collection}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
    return json.data;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/${this.collection}${path}`, {
      headers: this.headers,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
    return json.data;
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/${this.collection}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
    return json as T;
  }

  private async del<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/${this.collection}${path}`, {
      method: "DELETE",
      headers: this.headers,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
    return json as T;
  }

  async find(filter: Record<string, unknown> = {}, options?: FindOptions): Promise<Record<string, unknown>[]> {
    const params = this.buildQueryParams(filter, options);
    return this.get(`?${params}`);
  }

  async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const params = this.buildQueryParams(filter, { limit: 1 });
    try {
      const results = await this.get<Record<string, unknown>[]>(`?${params}`);
      return results.length > 0 ? results[0] : null;
    } catch {
      return null;
    }
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.get(`/${id}`);
    } catch {
      return null;
    }
  }

  async insertOne(doc: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("", { doc });
  }

  async insertMany(docs: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    return this.post("", { docs });
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: UpdateOp | Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const params = this.buildFilterParams(filter);
    try {
      const result = await this.patch<{ data: Record<string, unknown>[]; modified: number }>(`?${params}`, update);
      return result.data.length > 0 ? result.data[0] : null;
    } catch {
      return null;
    }
  }

  async deleteOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const params = this.buildFilterParams(filter);
    try {
      const result = await this.del<{ data: Record<string, unknown>[]; deleted: number }>(`?${params}`);
      return result.data.length > 0 ? result.data[0] : null;
    } catch {
      return null;
    }
  }

  async count(filter: Record<string, unknown> = {}): Promise<number> {
    const params = this.buildQueryParams(filter, {});
    const result = await this.get<{ count: number }>(`?count&${params}`);
    return result.count;
  }

  async search(query: string, options?: { limit?: number }): Promise<Record<string, unknown>[]> {
    const limit = options?.limit ?? 10;
    return this.get(`?search=${encodeURIComponent(query)}&limit=${limit}`);
  }

  async vectorSearch(embedding: number[], options?: { topK?: number }): Promise<Record<string, unknown>[]> {
    return this.post("?vector=true", { embedding, ...options });
  }

  private buildFilterParams(filter: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(filter)) {
      if (typeof value === "object" && value !== null) {
        const ops = value as Record<string, unknown>;
        for (const [op, val] of Object.entries(ops)) {
          const restOp = op.replace("$", "");
          parts.push(`${key}=${restOp}.${val}`);
        }
      } else {
        parts.push(`${key}=eq.${value}`);
      }
    }
    return parts.join("&");
  }

  private buildQueryParams(filter: Record<string, unknown>, options?: FindOptions): string {
    const parts = this.buildFilterParams(filter).split("&").filter(Boolean);
    if (options?.limit) parts.push(`limit=${options.limit}`);
    if (options?.offset) parts.push(`offset=${options.offset}`);
    if (options?.sort) {
      const sortParts = Object.entries(options.sort).map(
        ([k, v]) => `${k}.${v === -1 ? "desc" : "asc"}`,
      );
      parts.push(`sort=${sortParts.join(",")}`);
    }
    if (options?.allowScan) parts.push("allowScan=true");
    return parts.join("&");
  }
}

export class NoSqlNamespace {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, fetchFn: typeof fetch, headers: Record<string, string>) {
    this.baseUrl = `${baseUrl}/api/v1/nosql`;
    this.fetchFn = fetchFn;
    this.headers = headers;
  }

  collection(name: string): CollectionClient {
    return new CollectionClient(this.baseUrl, name, this.fetchFn, this.headers);
  }

  async init(schema: SchemaDeclaration): Promise<void> {
    const res = await this.fetchFn(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(schema),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error((json as Record<string, string>).error ?? `Schema sync failed: ${res.status}`);
    }
  }

  async getSchema(): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(this.baseUrl, {
      headers: this.headers,
    });
    const json = await res.json();
    return (json as Record<string, unknown>).data as Record<string, unknown>;
  }
}
