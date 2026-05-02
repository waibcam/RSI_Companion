// Long-lived port protocol for the "Sync LIVE → PTU" workflow.
//
// Why a port instead of the regular sendRsiMessage / RsiMessage union:
// the sync can take 30 seconds or more on a 100-contact friend list
// (sequential 300 ms pacing × throttle retries × server latency), and
// the popup needs to render progress live — current/total counter, the
// nickname being attempted right now, each result as it lands.
// chrome.runtime.sendMessage is request/response only; chrome.runtime
// .connect gives us a duplex channel that survives the long fetch
// without the popup just sitting on a "loading" spinner for half a
// minute.
//
// The popup connects with `chrome.runtime.connect({ name:
// CONTACTS_SYNC_TO_PTU_PORT })`, the BG accepts via
// `chrome.runtime.onConnect.addListener`. Either side may close;
// `port.disconnect()` from the BG signals "we're done", and a
// disconnect from the popup side is treated as an implicit cancel
// (the user closed the popup, no point continuing).

import type {
  ContactsSyncToPtuEntry,
  ContactsSyncToPtuResponsePayload,
} from './messaging.js';

/** Port name. Both sides must agree on this exact string. */
export const CONTACTS_SYNC_TO_PTU_PORT = 'contacts.syncToPtu.stream';

/** Events the BG pushes to the popup over the port. */
export type ContactsSyncToPtuStreamEvent =
  /** Sent first, after the initial bundle reads + classification.
   *  Tells the popup how big the queue is and how many entries are
   *  already accounted for as alreadyFriend / alreadyPending. */
  | {
      type: 'started';
      total: number;
      alreadyFriendCount: number;
      alreadyPendingCount: number;
    }
  /** Sent before each `addOne` attempt — drives the X / Y counter
   *  and the "currently trying: <handle>" hint. */
  | {
      type: 'progress';
      current: number;
      total: number;
      nickname: string;
    }
  /** Sent for every entry as soon as its status is decided — including
   *  the alreadyFriend/alreadyPending entries surfaced during the
   *  classification pass. The popup appends each to its log. */
  | {
      type: 'entry';
      entry: ContactsSyncToPtuEntry;
    }
  /** Sent when the loop finishes without being cancelled. Carries the
   *  same final summary the legacy message-based handler returned
   *  (entries + counts may be absent when one of the two sides isn't
   *  signed in — see ContactsSyncToPtuResponsePayload). */
  | {
      type: 'complete';
      result: ContactsSyncToPtuResponsePayload;
    }
  /** Sent when the popup posted a `cancel` message and the loop
   *  honoured it. Includes the partial entries collected so far so
   *  the popup can still show what got done. */
  | {
      type: 'cancelled';
      partialEntries: ContactsSyncToPtuEntry[];
    }
  /** Fatal error before / during the sync (auth missing, network
   *  outage, etc.). Distinct from per-entry `error` statuses inside
   *  the result. */
  | {
      type: 'error';
      message: string;
    };

/** Messages the popup posts back to the BG over the port. */
export type ContactsSyncToPtuStreamCommand =
  /** Tell the BG to stop the loop ASAP. The BG will finish whatever
   *  request is currently in flight (no way to abort RSI's HTTP
   *  request mid-flight cleanly) but won't start the next one. */
  | { type: 'cancel' };
