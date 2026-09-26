/**
 * S5-13 (G-111): the call context a feature code carries back. Moved to `@cuc/api-contracts` in
 * S5-15, because call-control reads it too (the console's recording buttons); re-exported here so
 * this service's own imports stay as they were.
 */
export {
  decodeRecordingContext,
  encodeRecordingContext,
  type RecordingCallContext,
} from '@cuc/api-contracts';
