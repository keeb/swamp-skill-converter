---
name: nightly-db-backup
description: Use when asked to back up a Postgres database — dumps it, uploads the dump to object storage, prunes old dumps, and posts a summary to chat.
allowed-tools: Bash, Read
---

# Back up a Postgres database

## 1. Dump

```bash
PGPASSWORD=$DB_PASSWORD pg_dump -Fc -h $DB_HOST -U $DB_USER $DB_NAME > /tmp/$DB_NAME.dump
```

## 2. Upload

```bash
aws s3 cp /tmp/$DB_NAME.dump s3://$BUCKET/$DB_NAME/$(date +%F).dump
```

## 3. Verify

```bash
pg_restore --list /tmp/$DB_NAME.dump
```

The listing must succeed and contain at least one table.

## 4. Prune

Delete dumps older than the retention window:

```bash
aws s3 ls s3://$BUCKET/$DB_NAME/ | sort
```

## 5. Report

Post the dump size and duration to the team channel via
https://hooks.example.com/backups. Ask before deleting anything outside the
retention window.
