# Deploying LEGA on Coolify

The stack is in [`docker-compose.coolify.yml`](../docker-compose.coolify.yml).
Coolify builds the server and webapp from this repository.

## Set up

1. **New resource → Public Repository** (or a GitHub App source for a private
   repo), build pack **Docker Compose**, compose file `/docker-compose.coolify.yml`.
2. Set the domain on the **proxy** service only, e.g. `https://lega.example.com`.
   Leave every other service without a domain.
3. In **Environment Variables**, set `BASE_URL` to the same address. Add the
   mail settings (`MAIL_*`) so invites and password resets can be sent.
4. Deploy.

Coolify generates the database passwords, the JWT secret and the Garage admin
token (the `SERVICE_PASSWORD_*` variables) on the first deploy and keeps them.
Keep a copy of them somewhere safe: the backups can't be restored into a new
stack without the database password.

## Backups

The `backup` service runs every day at `BACKUP_HOUR_UTC` (default 02:00 UTC)
and keeps `BACKUP_KEEP_DAYS` (default 14) days in the `lega-backups` volume:

- `lega-db-<time>.sql.gz`: every database (system, plus one per organization,
  including organizations created later)
- `lega-files-<time>.tar.gz`: uploaded files from Garage

A first backup runs right after the first deploy.

**Off-site copies.** Set these variables and redeploy to also upload each
backup to an S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3):

| Variable | Example |
|---|---|
| `BACKUP_S3_BUCKET` | `lega-backups` |
| `BACKUP_S3_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_REGION` | `auto` |
| `BACKUP_S3_PROVIDER` | `Cloudflare`, `AWS` or `Other` |
| `BACKUP_S3_ACCESS_KEY_ID` | |
| `BACKUP_S3_SECRET_ACCESS_KEY` | |

Old copies in the bucket aren't removed; set a lifecycle rule on the bucket.

**Take or list backups by hand.** Open the `backup` container's terminal in
Coolify and run `lega-backup now` or `lega-backup list`.

## Restoring

From the `backup` container's terminal:

```bash
zcat /backups/lega-db-<time>.sql.gz | MYSQL_PWD="$DB_PASSWORD" mariadb -h mysql -u "$DB_USER"
```

To restore uploaded files, stop the stack, then extract
`lega-files-<time>.tar.gz` into the `lega-garage` volume.
