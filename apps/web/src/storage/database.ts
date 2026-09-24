import Dexie, { type Table } from 'dexie';
import type {
  HealthRecord,
  Medication,
  Session,
  SyncOperation,
  SyncSnapshot,
} from '@simcare/shared';

export type StoredRecord = HealthRecord | Medication;
export interface PendingOperation {
  operationId: string;
  userId: string;
  sequence: number;
  operation: SyncOperation;
  local: StoredRecord;
  status: 'pending' | 'conflict' | 'failed' | 'stale';
  attempted: boolean;
  predecessorId?: string;
  server?: StoredRecord;
  error?: string;
}
export interface Workspace {
  userId: string;
  session: Session;
  serverSnapshot: SyncSnapshot;
  snapshot: SyncSnapshot;
  sequence: number;
}

export class SimCareDatabase extends Dexie {
  workspaces!: Table<Workspace, string>;
  outbox!: Table<PendingOperation, string>;
  metadata!: Table<{ key: string; value: string }, string>;

  constructor(name = 'simcare-local-v1') {
    super(name);
    this.version(1).stores({
      workspaces: '&userId',
      outbox: '&operationId,userId,[userId+sequence]',
      metadata: '&key',
    });
  }
}
