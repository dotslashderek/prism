// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3');
import type { Database as DatabaseType } from 'better-sqlite3';
import { Interaction, SearchResult, MemoryStoreOptions } from './types';

const DEFAULT_DIMENSIONS = 1536;

/** Converts a Float32Array to a Buffer for SQLite BLOB storage. */
const float32ToBuffer = (arr: Float32Array): Buffer => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);

/** Converts a SQLite BLOB (Buffer) back to a Float32Array. */
const bufferToFloat32 = (buf: Buffer): Float32Array => {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
};

/**
 * Computes cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
};

/** Maps a raw DB row to an Interaction. */
const rowToInteraction = (row: any): Interaction => ({
  id: row.id,
  operation: row.operation,
  method: row.method,
  path: row.path,
  resourceKey: row.resource_key,
  resourceId: row.resource_id ?? undefined,
  reqSummary: row.req_summary,
  resSummary: row.res_summary,
  reqBody: row.req_body ?? undefined,
  resBody: row.res_body,
  embedding: bufferToFloat32(row.embedding),
  isDeletion: row.is_deletion === 1,
  createdAt: row.created_at,
});

/**
 * Persistent semantic memory store backed by SQLite + sqlite-vec.
 *
 * Stores API interactions with vector embeddings for similarity search.
 * Falls back to brute-force JS cosine similarity if sqlite-vec is unavailable.
 */
export class MemoryStore {
  private readonly db: DatabaseType;
  private readonly dimensions: number;
  private readonly vecAvailable: boolean;

  constructor(options: MemoryStoreOptions) {
    const { dbPath, dimensions = DEFAULT_DIMENSIONS, disableVec = false } = options;

    this.dimensions = dimensions;
    this.db = new Database(dbPath);

    // Enable WAL mode for concurrent read/write
    this.db.pragma('journal_mode = WAL');

    // Create interactions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        resource_id TEXT,
        req_summary TEXT NOT NULL,
        res_summary TEXT NOT NULL,
        req_body TEXT,
        res_body TEXT NOT NULL,
        embedding BLOB NOT NULL,
        is_deletion INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    // Create index for resource lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_interactions_resource
        ON interactions(resource_key, resource_id, created_at DESC)
    `);

    // Attempt to load sqlite-vec
    this.vecAvailable = disableVec ? false : this._tryLoadVec();
  }

  /**
   * Store an interaction with its embedding vector.
   * @returns The interaction with its assigned database ID.
   */
  store(interaction: Omit<Interaction, 'id'>): Interaction {
    const insertInteraction = this.db.prepare(`
      INSERT INTO interactions (operation, method, path, resource_key, resource_id,
        req_summary, res_summary, req_body, res_body, embedding, is_deletion, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertVec = this.vecAvailable
      ? this.db.prepare(`INSERT INTO interaction_vecs (rowid, embedding) VALUES (?, ?)`)
      : null;

    const embeddingBlob = float32ToBuffer(interaction.embedding);

    const tx = this.db.transaction(() => {
      const result = insertInteraction.run(
        interaction.operation,
        interaction.method,
        interaction.path,
        interaction.resourceKey,
        interaction.resourceId ?? null,
        interaction.reqSummary,
        interaction.resSummary,
        interaction.reqBody ?? null,
        interaction.resBody,
        embeddingBlob,
        interaction.isDeletion ? 1 : 0,
        interaction.createdAt,
      );

      const id = Number(result.lastInsertRowid);

      if (insertVec) {
        // sqlite-vec requires BigInt for rowid, Float32Array for embedding
        insertVec.run(BigInt(id), interaction.embedding);
      }

      return id;
    });

    const id = tx();

    return { ...interaction, id };
  }

  /**
   * Search for similar interactions using vector similarity.
   * Results are ranked by `0.7 * similarity + 0.3 * recency`.
   * Excludes interactions for resources that have been deleted (tombstoned).
   *
   * @param queryEmbedding - The query vector
   * @param resourceKey - Filter results to this resource group
   * @param limit - Maximum results to return
   * @param threshold - Minimum similarity score to include (0-1)
   */
  search(queryEmbedding: Float32Array, resourceKey: string, limit = 5, threshold = 0.5): SearchResult[] {
    if (this.vecAvailable) {
      return this._vecSearch(queryEmbedding, resourceKey, limit, threshold);
    }
    return this._jsFallbackSearch(queryEmbedding, resourceKey, limit, threshold);
  }

  /**
   * Get the latest state for a specific entity.
   * @returns The latest interaction, or null if the entity was deleted.
   */
  getEntitySnapshot(resourceKey: string, resourceId: string): Interaction | null {
    const row = this.db
      .prepare(
        `SELECT * FROM interactions
         WHERE resource_key = ? AND resource_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(resourceKey, resourceId) as any;

    if (!row) return null;

    const interaction = rowToInteraction(row);
    return interaction.isDeletion ? null : interaction;
  }

  /**
   * Mark an entity as deleted by inserting a tombstone interaction.
   */
  markDeleted(resourceKey: string, resourceId: string): void {
    const tombstone: Omit<Interaction, 'id'> = {
      operation: `DELETE ${resourceKey}/${resourceId}`,
      method: 'DELETE',
      path: `${resourceKey}/${resourceId}`,
      resourceKey,
      resourceId,
      reqSummary: `Delete ${resourceKey}/${resourceId}`,
      resSummary: `Deleted ${resourceKey}/${resourceId}`,
      resBody: '{}',
      embedding: new Float32Array(this.dimensions),
      isDeletion: true,
      createdAt: Date.now(),
    };
    this.store(tombstone);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  /** Attempt to load the sqlite-vec extension. Returns true on success. */
  private _tryLoadVec(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(this.db);

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS interaction_vecs
          USING vec0(embedding float[${this.dimensions}])
      `);

      return true;
    } catch {
      // sqlite-vec unavailable — fall back to JS cosine
      return false;
    }
  }

  /**
   * Vector search using sqlite-vec KNN (L2 distance).
   * Over-fetches to allow post-filtering of tombstoned resources.
   */
  private _vecSearch(queryEmbedding: Float32Array, resourceKey: string, limit: number, threshold: number): SearchResult[] {
    // Over-fetch: KNN returns all resources, we post-filter by resource_key
    const fetchLimit = limit * 5;

    // KNN query against vec0, join back to interactions for full data
    const rows = this.db
      .prepare(
        `SELECT i.*, v.distance
         FROM interaction_vecs v
         INNER JOIN interactions i ON i.id = v.rowid
         WHERE v.embedding MATCH ? AND v.k = ?
         ORDER BY v.distance`,
      )
      .all(queryEmbedding, fetchLimit) as any[];

    // Post-filter by resource_key (vec0 KNN doesn't support WHERE on joined cols)
    const filtered = rows.filter(r => r.resource_key === resourceKey);

    return this._applyRecencyAndFilter(filtered, limit, threshold);
  }

  /** Brute-force JS cosine similarity search (fallback). */
  private _jsFallbackSearch(queryEmbedding: Float32Array, resourceKey: string, limit: number, threshold: number): SearchResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM interactions WHERE resource_key = ?`)
      .all(resourceKey) as any[];

    const scored = rows.map(row => {
      const embedding = bufferToFloat32(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      return { ...row, distance: 1 - similarity };
    });

    scored.sort((a, b) => a.distance - b.distance);

    return this._applyRecencyAndFilter(scored, limit, threshold);
  }

  /**
   * Post-processing shared by both search paths:
   * 1. Filter out tombstoned resources
   * 2. Apply recency-weighted scoring
   * 3. Re-sort and limit
   */
  private _applyRecencyAndFilter(rows: any[], limit: number, threshold: number): SearchResult[] {
    // Find resource IDs with active tombstones
    const deletedResourceIds = new Set<string>();
    for (const row of rows) {
      if (row.is_deletion === 1 && row.resource_id) {
        deletedResourceIds.add(`${row.resource_key}:${row.resource_id}`);
      }
    }

    // Also check the DB for tombstones not in the current result set
    const allTombstones = this.db
      .prepare(
        `SELECT resource_key, resource_id FROM interactions
         WHERE is_deletion = 1 AND resource_id IS NOT NULL
         GROUP BY resource_key, resource_id
         HAVING created_at = MAX(created_at)`,
      )
      .all() as any[];

    for (const t of allTombstones) {
      // Check if the latest interaction for this resource is actually a deletion
      const latest = this.db
        .prepare(
          `SELECT is_deletion FROM interactions
           WHERE resource_key = ? AND resource_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(t.resource_key, t.resource_id) as any;

      if (latest && latest.is_deletion === 1) {
        deletedResourceIds.add(`${t.resource_key}:${t.resource_id}`);
      }
    }

    const now = Date.now();

    const results: SearchResult[] = rows
      .filter(row => {
        // Exclude tombstone rows themselves
        if (row.is_deletion === 1) return false;
        // Exclude interactions for deleted resources
        if (row.resource_id && deletedResourceIds.has(`${row.resource_key}:${row.resource_id}`)) return false;
        return true;
      })
      .map(row => {
        const distance: number = row.distance;
        const similarityScore = 1 / (1 + distance);
        const hoursAgo = Math.max(0, (now - row.created_at) / 3_600_000);
        const recencyScore = 1 / (1 + hoursAgo * 0.1);
        const score = 0.7 * similarityScore + 0.3 * recencyScore;

        return { ...rowToInteraction(row), score };
      })
      .filter(result => result.score >= threshold);

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }
}
