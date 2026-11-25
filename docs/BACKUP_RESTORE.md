# Backup and restore

ServiceFlow has three things to protect:

1. **The PostgreSQL database.** It holds all business data, the audit log and the job queue.
2. **The object storage bucket.** It holds uploaded photos, signatures, documents and data exports.
3. **`ENCRYPTION_KEY`.** Without it, stored integration credentials and MFA seeds cannot be decrypted. Keep it in a password manager, separate from the database backups.

## Database

### Railway-managed backups

Railway Postgres volumes support scheduled backups under **Postgres service → Backups**. Turn on daily backups, and weekly ones if you need longer retention, for the production environment. A restore replaces the volume, so use it for disaster recovery, not to recover a single record.

### Logical backups (recommended in addition)

Take a compressed dump from any machine that has Postgres 16+ client tools. Use the **public** connection URL from the Postgres service (`DATABASE_PUBLIC_URL`):

```bash
pg_dump "$DATABASE_PUBLIC_URL" --format=custom --no-owner --file=serviceflow-$(date +%F).dump
```

Store dumps encrypted in a different provider or region, and keep at least 7 daily, 4 weekly and 12 monthly copies.

### Restore

Restore into an **empty** database:

```bash
pg_restore --dbname="$TARGET_DATABASE_URL" --no-owner --clean --if-exists serviceflow-YYYY-MM-DD.dump
```

Then point `DATABASE_URL` at the restored database and redeploy. Any newer migrations are applied on boot.

The `app_tenant` role and its RLS policies are created by migration `002_rls.sql`. Roles are global to the Postgres server, not part of a dump. When you restore into a fresh server, create the role **before** running `pg_restore`, so the grants and policies restore cleanly:

```bash
psql "$TARGET_DATABASE_URL" -c "DO \$\$BEGIN CREATE ROLE app_tenant NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END\$\$;"
```

## Object storage

Railway buckets are S3-compatible. Mirror the bucket on a schedule with any S3 tool, for example `rclone`:

```bash
rclone sync railway:serviceflow-files backup:serviceflow-files-backup --checksum
```

Documents reference storage keys, never public URLs. Restoring the bucket contents under the same keys is therefore enough.

## Restore drill

Run this every quarter:

1. Restore the latest dump into a scratch database, and start the app against it with `RUN_WORKER=false`.
2. Check `/api/health/ready`, sign in, and open a recent invoice PDF and a work-order photo.
3. Record how long it took, which is your real recovery time, and any problems.

## Tenant-level exports

Tenants can export customer data (JSON) through **Settings → Privacy**. Every list and report can be exported to CSV. These exports are for portability and are **not** a substitute for platform backups.
