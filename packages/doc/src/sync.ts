import { SYNC_MESSAGE, type SyncControl } from "@artifacts/schema/editing";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * The sync socket's messages (13, "The socket"), for the server and the editor's provider: a varuint
 * type, then y-protocols' sync or awareness payload, or our control JSON.
 */

const message = (type: number, write: (encoder: encoding.Encoder) => void) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
};

export const syncStep1 = (doc: Y.Doc) =>
  message(SYNC_MESSAGE.sync, (encoder) => syncProtocol.writeSyncStep1(encoder, doc));

export const syncStep2 = (doc: Y.Doc, stateVector?: Uint8Array) =>
  message(SYNC_MESSAGE.sync, (encoder) => syncProtocol.writeSyncStep2(encoder, doc, stateVector));

export const syncUpdate = (update: Uint8Array) =>
  message(SYNC_MESSAGE.sync, (encoder) => syncProtocol.writeUpdate(encoder, update));

export const awarenessMessage = (update: Uint8Array) =>
  message(SYNC_MESSAGE.awareness, (encoder) => encoding.writeVarUint8Array(encoder, update));

export const queryAwarenessMessage = () => message(SYNC_MESSAGE.queryAwareness, () => {});

export const controlMessage = (control: SyncControl) =>
  message(SYNC_MESSAGE.control, (encoder) => encoding.writeVarString(encoder, JSON.stringify(control)));

/**
 * The y-protocols sync sub-messages, and ours: `saved` tells a client that the server has persisted
 * its first `n` updates on this connection (step 2s and updates, counted from 1 after `hello`), so it
 * may forget them. Until then it keeps them, in memory and in its store.
 */
export const SYNC_STEP = {
  step1: syncProtocol.messageYjsSyncStep1,
  step2: syncProtocol.messageYjsSyncStep2,
  update: syncProtocol.messageYjsUpdate,
  saved: 100,
} as const;

export const savedMessage = (count: number) =>
  message(SYNC_MESSAGE.sync, (encoder) => {
    encoding.writeVarUint(encoder, SYNC_STEP.saved);
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, count);
    encoding.writeVarUint8Array(encoder, encoding.toUint8Array(inner));
  });

export const readSaved = (payload: Uint8Array) => decoding.readVarUint(decoding.createDecoder(payload));

export type Incoming =
  | { type: "sync"; step: number; payload: Uint8Array }
  | { type: "awareness"; update: Uint8Array }
  | { type: "auth"; reason: string }
  | { type: "queryAwareness" }
  | { type: "control"; json: unknown }
  | { type: "unknown" };

/** Reads one message. Throws on a malformed one, which the server answers by closing. */
export function readMessage(data: Uint8Array): Incoming {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  switch (type) {
    case SYNC_MESSAGE.sync: {
      const step = decoding.readVarUint(decoder);
      return { type: "sync", step, payload: decoding.readVarUint8Array(decoder) };
    }
    case SYNC_MESSAGE.awareness:
      return { type: "awareness", update: decoding.readVarUint8Array(decoder) };
    case SYNC_MESSAGE.auth:
      decoding.readVarUint(decoder);
      return { type: "auth", reason: decoding.readVarString(decoder) };
    case SYNC_MESSAGE.queryAwareness:
      return { type: "queryAwareness" };
    case SYNC_MESSAGE.control:
      return { type: "control", json: JSON.parse(decoding.readVarString(decoder)) };
    default:
      return { type: "unknown" };
  }
}

/** One entry of an awareness update, as y-protocols encodes it. */
export type AwarenessEntry = { client: number; clock: number; state: unknown };

export function decodeAwareness(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const entries: AwarenessEntry[] = [];
  for (let i = 0; i < count; i++) {
    const client = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    entries.push({ client, clock, state: JSON.parse(decoding.readVarString(decoder)) });
  }
  return entries;
}

export function encodeAwareness(entries: AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.client);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}

export {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
