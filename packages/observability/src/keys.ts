/**
 * Redis keys shared by the processes that write them and the API that reads them for /metrics.
 * Value of each is an ISO-8601 time.
 */
/** Refreshed every 30 s by every worker (key expires after 90 s: a missing key means no worker is alive). */
export const HEARTBEAT_KEY = 'worker:heartbeat';
/** Written by ops/backup.sh after each successful backup (and re-written by the backup container at start from its newest manifest). */
export const BACKUP_LAST_SUCCESS_KEY = 'backup:last_success';
