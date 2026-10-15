# Retention

- Keep 14 daily dumps.
- Never delete the most recent dump.

```sh
aws s3 rm s3://$BUCKET/$DB_NAME/old.dump
```
