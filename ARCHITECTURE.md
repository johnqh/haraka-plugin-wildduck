# Haraka WildDuck Plugin Architecture

## Overview

The `haraka-plugin-wildduck` is an SMTP plugin for Haraka that enables email delivery to WildDuck mailboxes. It handles the complete email processing pipeline from SMTP reception through authentication, validation, filtering, and final storage.

## System Components

### 1. Main Plugin (`index.js`)

The entry point that registers Haraka hooks and orchestrates the email processing flow.

**Key Responsibilities:**
- Plugin registration and configuration loading
- Database connection management (MongoDB + Redis)
- SMTP hook implementations (MAIL, RCPT, DATA, QUEUE, DENY)
- Rate limiting enforcement
- Recipient validation and resolution
- Message queueing and storage orchestration

**Hook Flow:**
```
MAIL FROM → hook_mail → SPF validation
    ↓
RCPT TO → hook_rcpt → Address resolution, quota checks, rate limiting
    ↓
DATA → hook_data_post → DKIM/ARC/DMARC/BIMI verification
    ↓
QUEUE → hook_queue → Spam filtering, forwarding, storage, autoreplies
    ↓
DENY → hook_deny → Rejection logging
```

### 2. Database Layer (`lib/db.js`)

Manages connections to MongoDB and Redis.

**Features:**
- Multi-database support (main, users, gridfs, sender)
- Connection pooling and retry logic
- Handler initialization (UserHandler, MessageHandler, SettingsHandler)
- Redis TTL counter setup for rate limiting

**Connection Structure:**
```javascript
{
  database: MongoDB,      // Main message storage
  users: MongoDB,         // User account database
  gridfs: MongoDB,        // Attachment storage (GridFS)
  senderDb: MongoDB,      // Outbound queue (ZoneMTA)
  redis: RedisClient,     // Rate limiting and caching
  userHandler: UserHandler,
  messageHandler: MessageHandler,
  settingsHandler: SettingsHandler
}
```

### 3. Authentication Layer (`lib/auth.js`)

Implements email authentication protocols using the `mailauth` library.

**Protocols Supported:**
- **SPF** (Sender Policy Framework) - Validates sender IP authorization
- **DKIM** (DomainKeys Identified Mail) - Verifies message signature integrity
- **ARC** (Authenticated Received Chain) - Validates forwarding chain
- **DMARC** (Domain-based Message Authentication) - Policy enforcement
- **BIMI** (Brand Indicators for Message Identification) - Logo validation

**Authentication Flow:**
1. SPF checked during MAIL FROM (hookMail)
2. DKIM/ARC/DMARC/BIMI verified during DATA (hookDataPost)
3. Results stored in `txn.notes.*Result`
4. Headers added via `connection.auth_results()`
5. Detailed metrics logged to GELF

### 4. Hook Wrappers (`lib/hooks.js`)

Thin wrappers around authentication functions that integrate with Haraka's hook system.

**Functions:**
- `mail()` - Wraps SPF validation with logging
- `dataPost()` - Creates stream for DKIM verification

### 5. Stream Collector (`lib/stream-collect.js`)

Transform stream that buffers message chunks for later processing.

**Purpose:**
- Collects email body chunks during transmission
- Maintains chunks array and total length
- Enables message reuse (forwarding, storage, autoreplies)
- Pass-through design preserves stream flow

## Data Flow Architecture

### Transaction State (`txn.notes`)

Each SMTP transaction maintains state in `txn.notes`:

```javascript
txn.notes = {
  id: ObjectId,                    // Unique transaction identifier
  sender: 'sender@example.com',    // MAIL FROM address
  transmissionType: 'ESMTPS',      // Protocol used (ESMTP/SMTP/TLS)
  rejectCode: 'CODE',              // Last rejection reason

  // Authentication results
  spfResult: { status, domain },
  dkimResult: { results: [] },
  arcResult: { status },
  dmarcResult: { status },
  bimiResult: { status },

  // Recipient tracking
  targets: {
    users: Map,                    // User mailboxes
    forwards: Map,                 // Forwarding addresses
    recipients: Set,               // All recipients
    autoreplies: Map,              // Autoreply configs
    forwardCounters: Map           // Rate limit trackers
  },

  // Rate limiting
  rateKeys: [],                    // Keys to increment after delivery

  // Configuration
  settings: {
    'const:max:storage': Number,
    'const:max:recipients': Number,
    'const:max:forwards': Number
  }
};
```

### Recipient Resolution Flow

```
1. Normalize address (handle SRS, punycode)
2. Check for wildcard (*) - reject
3. Resolve address via userHandler.resolveAddress()
   ├─ Regular user → Check quota, rate limits
   ├─ Forwarding address → Check forward rate limits
   └─ No match → Reject (no such user)
4. For regular users:
   - Validate user exists and enabled
   - Check storage quota
   - Apply per-IP rate limiting
   - Apply per-recipient rate limiting
5. Store target in txn.notes.targets
6. Accept recipient (OK)
```

### Message Processing Flow (QUEUE Hook)

```
1. Check Rspamd blacklist/softlist → Reject if matched
2. Extract verification results (TLS, SPF, DKIM, ARC, BIMI)
3. Collect message stream → Buffer chunks
4. Forward message (if needed):
   ├─ Skip if spam score too high
   ├─ Queue message to maildrop
   ├─ Increment forward counters
   └─ Log forwarding to GELF
5. Send autoreplies (if needed):
   ├─ Check autoreply time window
   ├─ Check rate limits
   └─ Queue autoreply message
6. Store to user mailboxes:
   ├─ Fetch BIMI logo (if validated)
   ├─ For each recipient user:
   │   ├─ Apply filter rules
   │   ├─ Check spam routing
   │   ├─ Store message
   │   └─ Log storage result
   └─ Update rate limits
7. Return OK or DENYSOFT
```

## Rate Limiting

### Strategy

Uses Redis TTL counters with sliding time windows.

### Selectors

- `rcpt` - Messages per recipient per hour (default: 60)
- `rcptIp` - Messages per recipient per IP per minute (default: 100)
- `wdf` - Forward messages per address per hour

### Implementation

1. **Check Phase** (RCPT TO):
   - Call `checkRateLimit(selector, key, 0)` with increment=0
   - Reject if limit exceeded (DENYSOFT, 450)

2. **Update Phase** (QUEUE success):
   - Call `updateRateLimit(selector, key, 1)` with increment=1
   - Store keys in `txn.notes.rateKeys` during RCPT

3. **Counter Keys**:
   - `rl:rcpt:{userId}` - Per-user limit
   - `rl:rcptIp:{remoteIp}:{userId}` - Per-IP per-user limit
   - `wdf:{addressId}` - Forwarding limit

## Spam Filtering Integration

### Rspamd Integration

- Reads spam scores from `txn.results.get('rspamd')`
- Supports blacklist (hard reject) and softlist (temp reject)
- Configurable score threshold for skipping forwards
- Custom rejection messages with `{host}` placeholder

### Configuration

```yaml
rspamd:
  forwardSkip: 10                   # Skip forwarding if score >= 10
  blacklist:
    - DMARC_POLICY_REJECT           # Immediate rejection symbols
  softlist:
    - RBL_ZONE                      # Temporary rejection symbols
  responses:
    DMARC_POLICY_REJECT: "Custom message with {host}"
```

## Forwarding Architecture

### Forwarding Address Types

1. **Mail** (`type: 'mail'`) - Forward to another email address
2. **Relay** (`type: 'relay'`) - Forward through specific MTA

### Forwarding Process

1. Resolve forwarding address via `userHandler.resolveAddress()`
2. Check forwarding rate limits
3. Store targets in `txn.notes.targets.forwards`
4. During QUEUE:
   - Check spam score threshold
   - Queue message to maildrop (ZoneMTA)
   - Increment forward counters
5. Collect message chunks via StreamCollect
6. Pipe to both forwarding and storage simultaneously

## Autoreply System

### Autoreply Conditions

1. Address has `autoreply` configuration
2. Current time within `start` and `end` window
3. Sender is referenced in To:/Cc: headers
4. Rate limits not exceeded

### Autoreply Flow

1. Collect list of autoreply addresses during RCPT
2. Filter by header references (`getReferencedUsers()`)
3. After forwarding, send autoreplies:
   - Check time window
   - Generate response via `autoreply()` function
   - Queue to maildrop
   - Log to GELF

## Storage Architecture

### Message Storage

Uses WildDuck's `FilterHandler.storeMessage()`:

1. **Parse Message** - MIME structure, headers, body
2. **Apply Filters** - User-defined filter rules
3. **Route Message** - Inbox vs Junk (based on spam score)
4. **Store Attachments** - GridFS with deduplication
5. **Store Message** - MongoDB with metadata
6. **Trigger Actions** - Webhooks, notifications

### Attachment Handling

- Stored in GridFS (`attachments` bucket)
- Base64 decoding optional (`attachments.decodeBase64`)
- SHA256 hash for deduplication
- Linked to messages via attachment IDs

### Message Metadata

```javascript
meta: {
  transactionId: queueId,
  source: 'MX',
  from: envelopeSender,
  to: [recipients],
  origin: remoteIP,
  transhost: heloHostname,
  transtype: 'ESMTPS',
  spamScore: Number,
  spamAction: 'accept|reject',
  time: Date
}
```

## Error Handling

### Error Codes

Tracked in `txn.notes.rejectCode`:

- `NO_SUCH_USER` - Unknown recipient
- `MBOX_DISABLED` - Account disabled
- `MBOX_FULL` - Quota exceeded
- `RATE_LIMIT` - Too many messages
- `DMARC_POLICY_REJECT` - DMARC policy violation
- `ERRQ01-ERRQ07` - Queue processing errors
- `ERRC01-ERRC03` - RCPT processing errors

### Response Types

- `OK` (250) - Accepted
- `DENY` (5xx) - Permanent failure
- `DENYSOFT` (4xx) - Temporary failure (retry)

### GELF Logging

All significant events logged with structured data:

```javascript
plugin.loggelf({
  short_message: '[ACTION] description',
  _mail_action: 'rcpt_to|process|forward|autoreply',
  _from: sender,
  _to: recipient,
  _queue_id: queueId,
  _ip: remoteIP,
  _user: userId,
  _error: errorMessage,
  _failure: 'yes',
  // ... additional context fields
});
```

## Security Considerations

### Authentication

- Private IPs get SPF softfail (cannot validate)
- DKIM minimum key size enforced (`auth.minBitLength`)
- DMARC policy respected for rejection
- ARC validation for forwarded messages

### Rate Limiting

- Multiple dimensions (per-user, per-IP, forwarding)
- Sliding windows prevent burst attacks
- Configurable limits per selector
- Redis-backed for distributed deployments

### Validation

- SRS signature validation for bounces
- Wildcard addresses marked with X-Original-Rcpt header
- Recipient normalization prevents bypass
- Quota enforcement before acceptance

## Configuration Management

### File: `config/wildduck.yaml`

**Key Sections:**
- `redis` - Redis connection (standalone or Sentinel)
- `mongo` - MongoDB databases (main, users, gridfs, sender)
- `sender` - ZoneMTA integration
- `srs` - Bounce handling secret
- `attachments` - Storage configuration
- `limits` - Rate limiting thresholds
- `gelf` - Logging configuration
- `rspamd` - Spam filtering rules
- `auth` - Authentication parameters

### Dynamic Reloading

Configuration reloads automatically when `wildduck.yaml` changes via Haraka's config system callback.

## Performance Considerations

### Database Connection Retry

- Automatic reconnection every 2 seconds on failure
- Plugin initialization continues while retrying
- RCPT checks wait up to 8 seconds for DB availability

### Stream Processing

- Minimal memory footprint via streaming
- Message chunks collected once, reused multiple times
- Parallel processing of forwarding and storage

### Rate Limit Caching

- Redis TTL counters (O(1) operations)
- Check before increment (avoids wasteful updates)
- Batch updates at end of transaction

## Monitoring & Observability

### GELF Integration

Every transaction stage logged:
- MAIL FROM acceptance
- RCPT TO validation (with resolution details)
- Authentication results (SPF, DKIM, DMARC, ARC, BIMI)
- Spam filtering decisions
- Forwarding operations
- Autoreply generation
- Storage results
- Rejection reasons

### Metrics Tracked

- Rate limit hits (key, selector, value, TTL)
- Quota exhaustion (user, storage used, quota)
- Authentication failures (protocol, reason)
- Spam scores and symbols
- Attachment metadata (count, size, hash)
- Filter rule matches
- Processing timestamps

## Integration Points

### WildDuck Core

- `UserHandler` - User and address management
- `MessageHandler` - Message storage and retrieval
- `SettingsHandler` - Global configuration
- `FilterHandler` - Message filtering and routing
- `BimiHandler` - BIMI logo caching
- `Maildropper` - Outbound queue (ZoneMTA)
- `autoreply` - Vacation response generator

### External Services

- **Rspamd** - Spam scoring via Haraka plugin
- **ZoneMTA** - Outbound delivery (via MongoDB queue)
- **Graylog** - Log aggregation (GELF protocol)
- **DNS** - SPF/DKIM/DMARC/BIMI lookups

## Development Notes

### Adding New Hooks

1. Register hook in `exports.register()`
2. Implement `exports.hook_*` function
3. Add transaction state to `init_wildduck_transaction()` if needed
4. Log significant events via `plugin.loggelf()`

### Modifying Rate Limits

1. Add limit config to `wildduck.yaml` under `limits`
2. Choose selector name (e.g., `newLimit`)
3. Add window size config (`newLimitWindowSize`)
4. Call `checkRateLimit()` during validation phase
5. Store key in `txn.notes.rateKeys` for later update

### Testing Changes

```bash
npm run lint         # Check code style
npm run lint:fix     # Auto-fix style issues
npm test            # Run full test suite
```

### Common Pitfalls

- **Transaction notes lifecycle** - Initialize in `init_wildduck_transaction()`, not in individual hooks
- **Stream consumption** - Message stream can only be read once, use StreamCollect to buffer
- **Async database calls** - Always handle errors, database may not be available immediately
- **Rate limit ordering** - Check THEN increment, not the other way around
- **GELF field naming** - Use underscores (`_field_name`), not camelCase
