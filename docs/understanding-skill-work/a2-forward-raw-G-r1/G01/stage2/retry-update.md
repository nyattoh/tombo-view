# Retry reference update

Synthetic update to the relay guide: The provider deduplication reference is stable only while the same worker process handles a queue item. If a worker restarts before retrying, the item receives a new provider reference. The configured retry waits and 24-hour queue expiry are unchanged.
