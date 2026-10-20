import { Spinner } from './Spinner';

/** A centred, announced loading block for a whole screen or panel. */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return <Spinner label={label} />;
}
