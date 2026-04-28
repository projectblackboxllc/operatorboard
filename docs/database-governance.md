# Database Governance

OperatorBoard treats database access as a separate risk class.

Plain English:

- An AI agent can destroy your database faster than you can read the logs.
- A backup is not optional if you allow destructive database autonomy.
- Generic shell access is not an acceptable substitute for structured database controls.

## 1. Capability Model

Database access is split into four levels:

- `none`: no database actions are allowed
- `read_only`: read queries only
- `write_safe`: inserts, limited updates, and backup creation
- `write_destructive`: deletes, schema changes, backup restore, and raw execution only when explicitly enabled

Destructive database actions include:

- deleting rows
- altering schemas
- restoring backups over live data
- executing raw SQL
- running database shells outside the structured `db.*` action family

## 2. Approval UX

Destructive database actions should never look like normal approvals.

OperatorBoard surfaces:

- plain-English danger text
- estimated affected rows when provided
- backup verification time and reference
- explicit acknowledgement before approval when destructive DB approvals are enabled

If backup evidence is missing or stale, the action is blocked and cannot be approved.

## 3. Backup Policy

Recommended baseline:

- require a recent backup before destructive DB approvals
- set a maximum acceptable backup age
- require explicit operator acknowledgement
- disable raw SQL, schema changes, and backup restore unless there is a real operational reason

Current enforcement:

- destructive DB actions are blocked if there is no matching OperatorBoard backup attestation
- destructive DB approvals fail if the attested backup is older than the configured age
- destructive DB approvals fail without explicit operator acknowledgement when that policy is enabled

## 4. API and Schema

The shared schema now includes:

- `constraints.database.access`
- `constraints.database.allowRawSql`
- `constraints.database.allowSchemaChanges`
- `constraints.database.allowBackupRestore`
- `constraints.database.backupPolicy.*`
- `action.safety.*` metadata for plain-English risk, row estimates, and backup evidence
- `BackupAttestation` records stored by OperatorBoard itself

Structured database action types should use the `db.*` namespace, for example:

- `db.query.read`
- `db.row.insert`
- `db.row.update`
- `db.row.delete`
- `db.schema.alter`
- `db.backup.create`
- `db.backup.restore`
- `db.query.execute`

Do not rely on shell commands with database credentials as a governance strategy.

## 5. Independent Attestations

OperatorBoard now distinguishes between:

- agent claim: "I used backup `backup_2025_04_27`"
- platform attestation: "OperatorBoard independently recorded that backup `backup_2025_04_27` exists and was verified at a specific time"

Destructive DB approvals use the platform attestation, not the agent claim alone.

Current API surface:

- `POST /backup-attestations`
- `GET /backup-attestations`
- `POST /backup-attestations/integrations/:provider`

This is the minimum trust boundary needed before deeper backup-provider integrations are added.

Signed integration ingestion rules:

- provider must be configured in `OPERATORBOARD_BACKUP_INTEGRATION_SECRETS`
- request must include `x-operatorboard-timestamp`
- request must include `x-operatorboard-signature`
- signature is HMAC-SHA256 over `timestamp + "." + canonical_json_body`
- signatures expire after a short freshness window
- rejected attempts are audited
