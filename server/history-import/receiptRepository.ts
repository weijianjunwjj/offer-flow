import type { SqliteDatabase } from '../db';

export interface HistoricalImportReceipt {
  idempotencyKey: string;
  sessionId: string;
  requestHash: string;
  resultJson: string;
  createdAt: number;
}

interface HistoricalImportReceiptRow {
  idempotency_key: string;
  session_id: string;
  request_hash: string;
  result_json: string;
  created_at: number;
}

function rowToReceipt(row: HistoricalImportReceiptRow): HistoricalImportReceipt {
  return {
    idempotencyKey: row.idempotency_key,
    sessionId: row.session_id,
    requestHash: row.request_hash,
    resultJson: row.result_json,
    createdAt: row.created_at,
  };
}

export class HistoricalImportReceiptRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findByIdempotencyKey(idempotencyKey: string): HistoricalImportReceipt | null {
    const row = this.db
      .prepare(`
        SELECT idempotency_key, session_id, request_hash, result_json, created_at
        FROM historical_import_receipts
        WHERE idempotency_key = ?
      `)
      .get(idempotencyKey) as HistoricalImportReceiptRow | undefined;
    return row === undefined ? null : rowToReceipt(row);
  }

  insert(receipt: HistoricalImportReceipt): void {
    this.db.prepare(`
      INSERT INTO historical_import_receipts (
        idempotency_key, session_id, request_hash, result_json, created_at
      ) VALUES (
        @idempotencyKey, @sessionId, @requestHash, @resultJson, @createdAt
      )
    `).run(receipt);
  }
}
