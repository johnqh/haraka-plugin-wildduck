# Improvement Plans for @sudobility/haraka

## Priority 1 - High Impact

### 1. Break Down Monolithic index.js
- `index.js` is approximately 2024 lines containing all SMTP hooks, recipient handling, forwarding, autoreply, message storage, rate limiting, and spam processing. Extracting these into focused modules (e.g., `lib/recipient-handler.js`, `lib/forwarding.js`, `lib/autoreply.js`, `lib/spam-handler.js`, `lib/rate-limiter.js`) would dramatically improve readability, testability, and maintainability.
- The `real_rcpt_handler()` function alone handles SRS reversal, address normalization, forwarding address resolution, user validation, and rate limiting. Splitting this into composable steps would make the recipient handling pipeline easier to extend and debug.

### 2. Expand Test Coverage Beyond Mocks
- The four test files (`test/index.test.js`, `test/hooks.test.js`, `test/db.test.js`, `test/stream-collect.test.js`) use mock Haraka connection/transaction objects with no live database. While this is appropriate for unit tests, the absence of integration tests means the full SMTP pipeline (SPF -> DKIM -> DMARC -> Rspamd -> store) is only testable through the `wildduck-dockerized` E2E tests.
- Critical paths lacking test coverage: SRS address reversal logic, forwarding rate limit enforcement, autoreply time-window validation, and Rspamd blacklist/softlist rejection flow. These should be tested with realistic mock data.
- `lib/auth.js` (SPF/DKIM/ARC/DMARC/BIMI authentication) has no dedicated test file despite being a critical security component.

### 3. Add JSDoc to All Exported Functions and Hook Handlers
- The SMTP hook functions (`hook_mail`, `hook_rcpt`, `hook_data_post`, `hook_queue`, `hook_deny`, `hook_max_data_exceeded`) are the plugin's public API but lack JSDoc documenting their parameters, expected `txn.notes` state, and return values.
- `lib/auth.js` functions (`hookMail`, `hookDataPost`) perform security-critical authentication but have no JSDoc explaining the authentication result format, header insertion behavior, or error conditions.
- The DSN response creators (`DSN.rcpt_too_fast()`, `DSN.mbox_full_554()`) at the module level should be documented with their SMTP status codes and when each should be used.

## Priority 2 - Medium Impact

### 4. Improve Error Categorization and Observability
- Error codes (`ERRC01` through `ERRQ07`) are defined inline as string literals throughout `index.js`. Extracting them into a constants module with descriptive names (similar to `lib/event-bus/event-types.js` in the WildDuck fork) would improve log searchability and monitoring.
- GELF logging calls are scattered throughout `index.js` with varying field sets. Standardizing the GELF payload structure (required vs. optional fields) and adding a helper function would ensure consistent logging across all hooks.

### 5. Add Graceful Degradation for Database Connectivity
- The MongoDB connection retry in `lib/db.js` (every 2 seconds) lacks backoff and has no circuit breaker. During extended database outages, this causes continuous reconnection attempts. Adding exponential backoff and a configurable maximum retry count would reduce load on a recovering database.
- The RCPT hook has a 5-retry/8-second timeout for database operations, but the timeout mechanism could be improved with `AbortController` instead of the current Promise.race pattern, providing cleaner cleanup.

### 6. Document Configuration Schema
- `config/wildduck.yaml` is the primary configuration file but its schema is not formally documented. Fields like `limits.rcpt`, `limits.rcptIp`, `rspamd.blacklist`, `rspamd.softlist`, and `rspamd.forwardSkip` are only discoverable by reading `index.js`. Adding inline YAML comments or a separate configuration reference document would help operators configure the plugin correctly.

## Priority 3 - Nice to Have

### 7. Migrate to ESM
- The plugin uses CommonJS (`require`/`exports`) because Haraka v3.x requires it. Documenting this constraint prominently and preparing for ESM migration when Haraka supports it would ease the eventual transition. Adding a tsconfig.json for TypeScript type checking (JSDoc-based) without compilation could catch type errors in the meantime.

### 8. Add Performance Instrumentation
- The SMTP pipeline processes potentially thousands of messages per minute but has no timing instrumentation. Adding timing metrics for each hook phase (RCPT resolution, DKIM verification, Rspamd check, message storage) would help identify bottlenecks. These could be logged via GELF with `_duration_ms` fields.

### 9. Review and Update Patches
- `patches/http-deceiver+1.2.7.patch` exists for Node.js v20+ compatibility. This should be periodically checked against the upstream `http-deceiver` package to see if the fix has been incorporated, allowing removal of the patch.
- The `npm-check-updates` script (`npm run update`) exists but the update process is not documented. Adding a checklist for dependency updates (check patch applicability, run tests, verify SMTP flow) would reduce upgrade risk.
