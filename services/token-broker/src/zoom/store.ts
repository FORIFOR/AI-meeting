import { Firestore } from "@google-cloud/firestore";

export type ZoomRecord = Record<string, unknown>;
export interface ZoomStore {
  get(key: string): Promise<ZoomRecord | null>;
  put(key: string, value: ZoomRecord): Promise<void>;
  /** Atomic read/modify/write. Callback has no I/O and may be retried. */
  change(key: string, fn: (value: ZoomRecord | null) => ZoomRecord): Promise<ZoomRecord>;
}

export class FirestoreZoomStore implements ZoomStore {
  private db: Firestore;
  constructor(projectId: string, databaseId = "(default)") {
    this.db = new Firestore({ projectId, databaseId });
  }
  private ref(key: string) { return this.db.collection("ai_meeting_zoom").doc(key); }
  async get(key: string): Promise<ZoomRecord | null> { return (await this.ref(key).get()).data() ?? null; }
  async put(key: string, value: ZoomRecord): Promise<void> { await this.ref(key).set(value); }
  async change(key: string, fn: (value: ZoomRecord | null) => ZoomRecord): Promise<ZoomRecord> {
    return this.db.runTransaction(async tx => {
      const ref = this.ref(key), previous = (await tx.get(ref)).data() ?? null;
      const value = fn(previous);
      tx.set(ref, value);
      return value;
    });
  }
}
