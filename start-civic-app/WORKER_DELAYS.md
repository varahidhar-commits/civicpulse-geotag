# Worker Delays

Government officials receive private in-app alerts for their own assignments:
- `worker_not_started`: still assigned and unstarted at the start deadline.
- `worker_resolution_overdue`: in progress at the completion deadline without a submitted resolution.

Both dates are selected by government on assignment. Completion must follow start. Browser-local dates are sent as timezone-qualified ISO instants. Resolved/verified tasks do not generate completion alerts while waiting for citizen verification. Existing alerts remain historical and can be marked read.

The existing startup/interval scanner and notification-read catch-up scan handle both types. Each assignment/type has its own persistent deduplication marker and notification key. This retains the application's single-process JSON datastore model; multiple simultaneous server processes sharing that file are not supported.

## Existing assignments

No destructive data migration or invented retrospective deadline is applied. Old notifications still render. Active tasks with missing deadlines show an explanation. The assigning official can use **Set missing deadlines** in Government → Complaints; this preserves work status, start time and official ownership and initializes a missing assignment identifier. For an unstarted task with unknown assigning official, explicitly reassign it with both dates. Ownership of already-started legacy work is never guessed; an administrator must recover the original assigning official from trusted records before deadline setup.

## Validation and rollout

Run `npm ci` then `node --test tests/*.test.js` from `start-civic-app/backend` (Node 18+). API tests use an ephemeral loopback server and an in-memory mocked datastore; they do not write production or fixture data.

Review and merge the PR, then deploy through the normal process. Set deadlines for the legacy task shown in the screenshots. Check Worker → My tasks for both deadlines and Government → Worker Delays after each deadline in a test assignment. Notifications appear only for the official who assigned that task. Polling can take up to the configured scan interval; refreshing Worker Delays also checks immediately.
