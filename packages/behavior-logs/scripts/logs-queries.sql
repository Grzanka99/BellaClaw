-- Full trace for one turn.
SELECT createdAt, event, component, toolName, success, durationMs, summary
FROM app_event_logs
WHERE turnId = ?
ORDER BY createdAt, id;

-- Recent cron scheduling behavior.
SELECT createdAt, turnId, toolName, success, summary, metadataJson
FROM app_event_logs
WHERE toolName IN ('schedule-once', 'schedule-recurring', 'list-cron-jobs')
ORDER BY createdAt DESC
LIMIT 50;

-- Failed behavior.
SELECT createdAt, turnId, event, component, toolName, error
FROM app_event_logs
WHERE success = 0
ORDER BY createdAt DESC
LIMIT 50;
