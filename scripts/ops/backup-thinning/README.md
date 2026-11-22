# Paperclip backup thinning (vps-openclaw)

Paperclip dumps its database about every hour (~400 MB gzip each) into the
`paperclip_paperclip-data` volume, `instances/default/data/backups`. Its UI
(*Settings → General → Backup retention*) only offers "keep every dump for
3/7/14 days" plus weekly/monthly, so the target rotation (24 hourly + 7 daily
+ 4 weekly, my-supervision retention policy C25 / decision D13) needs this
small companion container.

## Setup

1. Paperclip UI: Daily = **7 days**, Weekly = **4 weeks**, Monthly = 1 month.
2. On vps-openclaw (user `qveys`, docker group, no sudo):

   ```sh
   mkdir -p /docker/paperclip-backup-thinning
   # copy docker-compose.yml and thin-backups.sh there, then:
   cd /docker/paperclip-backup-thinning
   docker compose run --rm -e DRY_RUN=1 backup-thinning --once   # check first
   docker compose up -d
   docker logs paperclip-backup-thinning
   ```

The container keeps every dump from the last 24 h and the latest dump of each
older day; Paperclip prunes beyond 7 days. Steady state: about 35 dumps
(~14 GB). It runs from the `paperclip:local` image, without network, read-only,
as uid 1000 (owner of the dumps), and does not restart Paperclip.

Both halves are required: Daily = 7 days without this container keeps ~168
hourly dumps (~67 GB).

## Rollback

`docker compose down` in `/docker/paperclip-backup-thinning`, set Daily back
to 3 days (and Weekly to 2 weeks) in the UI. Deleted dumps are not
recoverable.
