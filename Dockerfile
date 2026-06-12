# DMS Backup GUI – Backup/Restore + Webmail für Docker Mailserver
FROM node:22-alpine

# GNU tar für --transform/--strip-components beim Backup/Restore
RUN apk add --no-cache tar tini

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=80 \
    BACKUP_DIR=/backups

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/api/health || exit 1

# Root ist nötig, um Maildateien beliebiger UIDs lesen/schreiben zu können
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
