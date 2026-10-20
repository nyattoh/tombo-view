# Notification delivery guide

Synthetic development note for the sample notification relay.

- `accepted` means the relay stored a request in its queue. It does not mean a downstream provider or recipient has received it.
- `handed_off` means a downstream provider returned a successful response. The guide does not define this as confirmation that the recipient viewed the notification.
- The relay retries provider responses of `429` and `5xx` after documented waits of about 1, 4, and 16 minutes. These are configured delays, not measured delivery times.
- A queue item expires after 24 hours. The guide says the relay reuses the same provider deduplication reference when retrying a queue item.
