# Diagnostics

## Privacy and event reference

The API logs request time, handler name, status, duration, byte counts, request ID and an eight-character account pseudonym (or `-`). Server errors include a constrained error name/code and function/line/column stack frames. Client events contain only fields allowed by [diagSchema.js](../server/diagSchema.js), such as event name, timestamps, random tab/run/file IDs, browser version and build. The schema is the source of truth for client events.

These diagnostics do not log file names or paths, file contents, URLs, request bodies, passwords, tokens, cookies, usernames, phone numbers, error messages or full stack paths. Account pseudonyms are derived with the server pepper and can correlate activity for the same account; treat log files as private.

Set `CLOUDGRAM_DIAG_LOG=0` in the API environment and restart the service to disable API access logs and client ingestion. Set `VITE_FEATURE_DIAG_LOG=0` in the frontend build environment, rebuild and publish to disable the frontend logger. Existing open tabs need a reload to use the new build.

### Event catalogue

- `diag.start`: diagnostics started.
- `diag.lost`: events lost; `n` is the count.
- `err.global`: an uncaught client error; `errName` is its constrained name.
- `upload.entries.start`, `upload.entries.plan`, `upload.entries.stop`: batch size, planning counts and any stop reason.
- `run.finish`: final counts, duration, reason and notice severity for an upload run.
- `ui.notice`: notice severity and a fixed kind, without notice text.
- `upload.enqueue`, `queue.pump`: queue admission and changes in worker availability.
- `file.start`, `file.part.retry`, `file.done`, `file.fail`: transfer milestones, retries and failures.
- `tree.save`, `conn.state`, `remove.original`: vault saves, connection state and original-file outcomes.

The schema also defines upload, queue, file, connection, notice, swallowed-error and stall events. Upload-flow instrumentation is added separately.

## Read logs

Set `DEPLOY_HOST` in the environment or repo-root `.env`, and ensure SSH access to the service journal. The command also checks the main checkout `.env` if this worktree lacks one.

```sh
npm run logs -- --since "15 min ago"
npm run logs -- --since "15 min ago" --tab <tab-id>
npm run logs -- --since "15 min ago" --run <run-id>
npm run logs -- --since "15 min ago" --errors
npm run logs -- --since "15 min ago" --raw
```

The raw SSH equivalent is `ssh <host> journalctl -u cloudgram-api -o cat --since '15 min ago'`. For a browser log downloaded as JSON, run `npm run logs -- --file <path>`; use `--file -` to read standard input. `--raw` prints the input unchanged and does not apply filters. Server lines have their own group: timestamps share the first selected client event's base, so compare their offsets with that base. Tab/run filters do not remove server lines because they have no tab/run identity. `--errors` selects server errors, API 5xx and client `err.*` events; run summaries still use all events in the selected run.

## Investigating a stuck upload

Once upload events exist, find the tab and run, then inspect its final event. `LAST STAGE REACHED` names that run's last recorded event and says how long before the tab's last event it occurred. `NO run.finish` means no finish was recorded or the last event was `run.stall`; it does not prove the operation failed. The summary counts completed files, failed files and swallowed errors. Compare server offsets and request IDs to investigate nearby API activity. Missing events or a closed tab can leave an incomplete picture.

## Retention

The API writes JSON lines to stdout; systemd captures them in journald, which handles rotation and retention. VPS journal storage mode, limits and retention period have not been verified; inspect the VPS journald configuration and effective settings before relying on any retention period.
