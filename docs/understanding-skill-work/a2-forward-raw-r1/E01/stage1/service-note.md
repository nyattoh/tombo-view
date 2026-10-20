# Service behaviour note

This synthetic development note describes the demo report endpoint. A successful request is cached for 15 minutes. A `429` response is returned when the per-user limit is reached; error responses are not cached. The cache is cleared when the service restarts.
