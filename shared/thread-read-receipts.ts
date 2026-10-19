/** Acknowledges observed thread activity, never the time on the reading device. */
export type ThreadReadReceipt = {
  hostId: string;
  threadId: string;
  turnId: string;
  activityAt: number;
};

export type StoredThreadReadReceipt = {
  hostId: string;
  threadId: string;
  turnIds: string[];
  activityAt: number;
};

export const MAX_THREAD_READ_RECEIPTS = 3000;
export const MAX_THREAD_READ_TURN_IDS = 16;
export const MAX_THREAD_READ_RECEIPT_BATCH = 50;
// Unix seconds through year 9999; this also rejects accidental millisecond values.
export const MAX_THREAD_READ_ACTIVITY_AT = 253402300799;

export const threadReadReceiptKey = (receipt: Pick<ThreadReadReceipt, 'hostId' | 'threadId'>) =>
  JSON.stringify([receipt.hostId, receipt.threadId]);

const validIdentifier = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const validActivity = (value: unknown): value is number => typeof value === 'number' &&
  Number.isFinite(value) && value >= 0 && value <= MAX_THREAD_READ_ACTIVITY_AT;
const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Used at untrusted HTTP/WebSocket boundaries on both sides of the connection. */
export function isThreadReadReceipt(value: unknown): value is ThreadReadReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as ThreadReadReceipt;
  return exactKeys(value, ['hostId', 'threadId', 'turnId', 'activityAt']) &&
    validIdentifier(receipt.hostId) && validIdentifier(receipt.threadId) && validIdentifier(receipt.turnId) && validActivity(receipt.activityAt);
}

export function isStoredThreadReadReceipt(value: unknown): value is StoredThreadReadReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as StoredThreadReadReceipt;
  return exactKeys(value, ['hostId', 'threadId', 'turnIds', 'activityAt']) &&
    validIdentifier(receipt.hostId) && validIdentifier(receipt.threadId) && validActivity(receipt.activityAt) &&
    Array.isArray(receipt.turnIds) && receipt.turnIds.length > 0 && receipt.turnIds.length <= MAX_THREAD_READ_TURN_IDS &&
    receipt.turnIds.every(validIdentifier) && new Set(receipt.turnIds).size === receipt.turnIds.length;
}
