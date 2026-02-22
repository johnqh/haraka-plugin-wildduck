# haraka-plugin-wildduck - AI Development Guide

## Overview

SMTP delivery plugin for Haraka that integrates with the WildDuck mail server. Handles the complete inbound email pipeline: SMTP negotiation, email authentication (SPF/DKIM/DMARC/ARC/BIMI), spam filtering via Rspamd, rate limiting, recipient validation, message forwarding, autoreply generation, and final storage into MongoDB. This is the sole delivery plugin needed -- do not enable Haraka's built-in SPF or dkim_verify plugins alongside it.

- **Package**: `@sudobility/haraka` (v8.0.23)
- **License**: BUSL-1.1
- **Runtime**: Node.js >= 16.20.1 (Haraka SMTP daemon)
- **Package Manager**: npm (not Bun -- `bun.lock` exists but npm is canonical)
- **Language**: JavaScript (CommonJS, `require`/`exports`)
- **Repository**: https://github.com/johnqh/haraka-plugin-wildduck

## Project Structure

```
haraka-plugin-wildduck/
├── index.js                    # Main plugin (2024 lines) - all SMTP hooks and processing
├── lib/
│   ├── db.js                   # MongoDB/Redis connection management, handler init
│   ├── auth.js                 # Email auth (SPF/DKIM/ARC/DMARC/BIMI) via mailauth
│   ├── hooks.js                # Thin Haraka hook wrappers for mail and data_post
│   └── stream-collect.js       # Transform stream that buffers message chunks
├── config/
│   └── wildduck.yaml           # Primary config (DB, rate limits, spam, auth)
├── test/
│   ├── index.test.js           # Main plugin function tests
│   ├── hooks.test.js           # Hook wrapper tests
│   ├── db.test.js              # DB module interface tests
│   └── stream-collect.test.js  # StreamCollect tests
├── patches/
│   └── http-deceiver+1.2.7.patch  # Node.js v20+ compat patch (postinstall)
├── .github/workflows/ci-cd.yml    # CI/CD: NPM publish + Docker Hub
├── Dockerfile                  # Multi-stage: Haraka v3.1.1 + plugin
├── Gruntfile.js                # Grunt: ESLint + Mocha runner
├── eslint.config.js            # ESLint flat config (ES2022, Haraka globals)
├── .prettierrc.js              # 160 width, 4-space, single quotes, LF
├── ARCHITECTURE.md             # Detailed 500-line architecture guide
└── package.json                # Package definition and scripts
```

## Key Components

### SMTP Hook Flow

```
MAIL FROM ──► hook_mail()
               ├── init_wildduck_transaction()  → txn.notes setup
               └── hookMail() (lib/hooks.js)    → SPF via mailauth → Received-SPF header

RCPT TO ───► hook_rcpt()
               ├── DB retry (up to 5 attempts, 8s timeout)
               └── real_rcpt_handler()
                    ├── normalize_address()      → SRS fix, punycode
                    ├── SRS handling              → Reverse SRS, rate check, forward
                    ├── resolveAddress()          → MongoDB user/forwarding lookup
                    ├── handle_forwarding_address() → Rate limit, forward targets
                    ├── User validation           → Exists? Enabled? Quota?
                    └── checkRateLimit()          → rcptIp + rcpt checks

DATA ──────► hook_data_post()
               └── hookDataPost() (lib/auth.js)
                    ├── DKIM verify → ARC validate → DMARC check → BIMI validate
                    └── Auth results headers + GELF logging

QUEUE ─────► hook_queue()
               ├── Rspamd blacklist/softlist     → Reject if matched
               ├── forwardMessage()              → Queue to ZoneMTA via Maildropper
               ├── sendAutoreplies()             → Time-window check, queue autoreply
               ├── storeMessages()               → FilterHandler.storeMessage() per user
               │    ├── BIMI logo fetch, filter rules, spam routing
               │    └── MongoDB + GridFS storage
               └── updateRateLimits()            → Increment Redis counters

DENY ──────► hook_deny()                         → GELF rejection logging
MAX DATA ──► hook_max_data_exceeded()            → GELF oversize denial
```

### Database Connections (lib/db.js)

```javascript
plugin.db = {
    database: MongoClient,          // Main message DB (wildduck)
    users: MongoClient,             // User accounts (can be separate)
    gridfs: MongoClient,            // Attachment storage (GridFS)
    senderDb: MongoClient,          // Outbound queue (zone-mta)
    redis: RedisClient,             // Rate limiting counters
    userHandler: UserHandler,       // User/address resolution
    messageHandler: MessageHandler, // Message storage/retrieval
    settingsHandler: SettingsHandler // Global settings
}
// Also: plugin.ttlcounter, plugin.ttlcounterAsync, plugin.maildrop,
//        plugin.filterHandler, plugin.bimiHandler
```

Connection retry: MongoDB reconnects every 2 seconds on failure. RCPT hook retries 5 times with 8s hard timeout.

### Rate Limiting

Redis TTL counters with check-before-increment pattern: check (increment=0) during RCPT, increment (increment=1) after delivery in QUEUE.

| Selector | Key Pattern | Default | Window | Purpose |
|----------|-------------|---------|--------|---------|
| `rcpt` | `rl:rcpt:{userId}` | 60 | 1 hour | Per-recipient |
| `rcptIp` | `rl:rcptIp:{ip}:{userId}` | 100 | 1 min | Per-IP per-recipient |
| `wdf` | `wdf:{addressId}` | configurable | 1 hour | Forward rate |

Keys accumulate in `txn.notes.rateKeys[]` and batch-update via `updateRateLimits()`.

### Transaction Context (txn.notes)

```javascript
txn.notes = {
    id: ObjectId,                    // Transaction ID
    sender: 'from@example.com',      // MAIL FROM
    transmissionType: 'ESMTPS',      // E? + SMTP + S? (EHLO/TLS)
    rejectCode: 'CODE',              // For GELF logging

    // Auth results from lib/auth.js
    spfResult, dkimResult, arcResult, dmarcResult, bimiResult,

    // Recipient tracking
    targets: {
        users: Map,                  // userId -> {userData, recipient}
        forwards: Map,               // targetValue -> {type, value, recipient}
        recipients: Set,             // All normalized addresses
        autoreplies: Map,            // addrview -> addressData
        forwardCounters: Map         // addressId -> {increment, limit}
    },
    rateKeys: [],                    // {selector, key, limit} for post-delivery increment
    settings: { 'const:max:storage', 'const:max:recipients', 'const:max:forwards' }
};
```

### Spam Filtering (Rspamd)

Reads `txn.results.get('rspamd')` from Haraka's Rspamd plugin:
- **Blacklist** (`rspamd.blacklist`): Hard reject (DENY/550). E.g., `DMARC_POLICY_REJECT`.
- **Softlist** (`rspamd.softlist`): Temp reject (DENYSOFT/450). E.g., `RBL_ZONE`.
- **Forward skip** (`rspamd.forwardSkip`): Suppress forwarding above this score.
- Custom rejection messages support `{host}` placeholder for sender domain.

### Forwarding and Autoreplies

Forwarding types: `mail` (email forward) and `relay` (specific MTA, not rate limited). Processing order in QUEUE: forward message -> send autoreplies -> store to inbox.

Stream piping: `txn.message_stream -> StreamCollect -> Maildropper`. StreamCollect buffers chunks for reuse by storeMessage() and autoreply().

Autoreply conditions: `autoreply.status` truthy, current time within start/end window, recipient in To:/Cc: headers.

## Development Commands

```bash
npm install              # Install deps (patch-package runs via postinstall)
npm run lint             # ESLint on index.js and lib/
npm run lint:fix         # Auto-fix ESLint issues
npm test                 # ESLint + Mocha tests via Grunt
npm run update           # rm node_modules, ncu -u, npm install
```

**Tests**: Mocha + Chai (expect) + Sinon. Files in `test/**/*.test.js`. Mock Haraka connection/transaction objects; no live DB needed.

**Code style**: Prettier (160 chars, 4-space, single quotes, LF). Haraka globals (`OK`, `DENY`, `DENYSOFT`, etc.) injected at runtime, declared in eslint.config.js.

**Docker**: Multi-stage build cloning Haraka v3.1.1. Requires `NPM_TOKEN` build arg for `@sudobility` packages.

**CI/CD**: GitHub Actions on push/PR to master/develop. Shared workflow from `johnqh/workflows`.

## Architecture Patterns

**Plugin convention**: `exports.hook_{name}` functions auto-discovered by Haraka. Only `init_master`/`init_child` are explicitly registered in `register()`.

**DSN responses**: Custom DSN creators at module level: `DSN.rcpt_too_fast()` (450), `DSN.mbox_full_554()` (554). Errors carry `.resolution` metadata for GELF and `.responseAction`/`.responseMessage` for hook responses.

**GELF logging**: `plugin.loggelf({short_message, _mail_action, _from, _to, _queue_id, ...})`. Component: `'mx'`. All underscore-prefixed custom fields.

**Stream once**: Message streams consumed once. StreamCollect buffers chunks for multi-use (forward + store + autoreply).

**SRS handling**: `^SRS\d+=` addresses reversed during RCPT TO, case-mangling fixed, forwarded to original address.

**Config reload**: `wildduck.yaml` auto-reloads via Haraka config watcher callback.

**WildDuck config disabled**: `process.env.DISABLE_WILD_CONFIG = 'true'` at module load prevents WildDuck from loading its own configs.

## Common Tasks

### Adding a New Authentication Check
1. Add logic in `lib/auth.js` in `hookMail()` (envelope) or `hookDataPost()` (body)
2. Store result in `txn.notes.{check}Result`
3. Add header via `connection.auth_results(result.info)`
4. Log metrics via `plugin.loggelf()` with `_mail_action`

### Adding a New SMTP Hook
1. Export `exports.hook_{name}` in `index.js` (auto-discovered)
2. Initialize state in `init_wildduck_transaction()` if needed
3. Use `txn.notes` for cross-hook state; call `next()` with response

### Modifying Rate Limits
1. Update `config/wildduck.yaml` `limits` section
2. For new dimension: add `checkRateLimit()` call in `real_rcpt_handler()`, push to `txn.notes.rateKeys`
3. Config keys: `limits.{selector}` (limit), `limits.{selector}WindowSize` (window)

### Modifying Recipient Handling
1. Edit `real_rcpt_handler()` in index.js
2. New address types: branch after `resolveAddress()` callback
3. Store in `txn.notes.targets.users` or `.forwards`; set `txn.notes.rejectCode` before reject

### Modifying Message Storage
1. Storage in `storeMessages()` within `hook_queue()`
2. `FilterHandler.storeMessage()` accepts `meta`, `verificationResults`, `chunks`, `mailbox`
3. `prepared` object (mimeTree + maildata) reused across recipients for efficiency

## Error Codes

| Code | Meaning | Response |
|------|---------|----------|
| `NO_SUCH_USER` | Unknown recipient | DENY |
| `MBOX_DISABLED` | Account disabled | DENY |
| `MBOX_FULL` | Quota exceeded | DENY |
| `RATE_LIMIT` | Rate limit hit | DENYSOFT |
| `ERRC01` | RCPT handler error | DENYSOFT |
| `ERRC02` | DB not available | DENYSOFT |
| `ERRC03` | RCPT timeout (8s) | DENYSOFT |
| `ERRQ01` | Stream pipe failure | DENYSOFT |
| `ERRQ04` | Forward stream error | DENYSOFT |
| `ERRQ05` | Storage failure | DENYSOFT |
| `ERRQ06` | Unexpected store error | DENYSOFT |
| `ERRQ07` | Too many nested attachments | DENY |
| `DroppedByPolicy` | Filter dropped message | OK (silent) |

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@sudobility/wildduck` | WildDuck core: UserHandler, MessageHandler, FilterHandler, BimiHandler, Maildropper, autoreply, counters |
| `mailauth` | SPF, DKIM verify, ARC, DMARC, BIMI authentication |
| `mongodb` | MongoDB driver v6 for storage |
| `ioredis` | Redis client for rate limiting |
| `haraka-dsn` | SMTP DSN response creation |
| `gelf` | GELF protocol client for Graylog logging |
| `nodemailer` | Used for `addressparser` (email parsing) |
| `libmime` | MIME header parsing, encoded-word decoding |
| `srs.js` | Sender Rewriting Scheme for bounces |
| `punycode.js` | Internationalized domain encoding |
| `patch-package` | Applies `patches/` on postinstall |

**Dev**: `mocha` + `chai` + `sinon` (testing), `grunt` + plugins (runner), `eslint` + `prettier` (style), `npm-check-updates` (updates).
