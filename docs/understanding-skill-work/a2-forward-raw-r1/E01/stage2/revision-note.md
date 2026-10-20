# Cache-key revision

Synthetic change note: successful reports are now cached by report ID only, not by user ID. The 15-minute TTL is unchanged. A user's `429` response is still not cached, but a later request for a report ID may receive a successful result cached by another user.
