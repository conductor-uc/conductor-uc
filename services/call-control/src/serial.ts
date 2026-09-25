/**
 * Runs tasks one at a time per key, in the order they were given, while
 * different keys run side by side.
 *
 * call-control uses it per FreeSWITCH node: a node's ESL events arrive in the
 * order FreeSWITCH raised them, and handling them in that order is what keeps
 * the outbox (and so every consumer, the realtime hub most of all) in step
 * with the call. Handled concurrently, a leg's CHANNEL_ANSWER could be written
 * before its CHANNEL_CREATE and find no call to update.
 *
 * A task that fails is reported to `onError` and does not stop the ones
 * after it.
 */
export function createSerialQueue(
  onError: (key: string, error: unknown) => void,
): (key: string, task: () => Promise<void>) => void {
  const tails = new Map<string, Promise<void>>();
  return (key, task) => {
    const tail = (tails.get(key) ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) => onError(key, error));
    tails.set(key, tail);
    // Forget an idle key, so a node that goes away leaves nothing behind.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
  };
}
