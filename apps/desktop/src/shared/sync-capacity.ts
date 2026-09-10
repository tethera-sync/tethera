/** Files per side the live sync engine can actually reconcile. A folder above this fails closed during sync, no matter how high the scan limit is set. */
export const MAX_SYNCABLE_FILES_PER_SIDE = 10_000
