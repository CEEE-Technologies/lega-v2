# Nightly backups of every MariaDB database and the Garage files (see backup.sh).
FROM rclone/rclone:1.68.2 AS rclone

FROM mariadb:10.11
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY backup.sh /usr/local/bin/lega-backup
RUN chmod +x /usr/local/bin/lega-backup
ENTRYPOINT ["/usr/local/bin/lega-backup"]
CMD ["schedule"]
