import { useCallback, useState } from 'react';
import { newIdempotencyKey } from '../lib/hooks';

/**
 * The key a create form sends with its request. One per attempt: it is made when the form opens and stays the same for
 * every retry after a failure or a timeout, so the server can tell a retry from a new request and never create twice.
 * Call `renew` only after the create succeeded and the form stays open for another one. (A form that closes after saving
 * needs nothing: the next opening mounts it afresh and gets a new key.)
 */
export function useIdempotencyKey(): { key: string; renew: () => void } {
  const [key, setKey] = useState(newIdempotencyKey);
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return { key, renew };
}
