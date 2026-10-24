FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# pg_dump for the Developer dashboard's "Download backup", from the PostgreSQL project's own packages (its signing
# key ships inside Debian's postgresql-common), one per server version Railway may run; the app picks the match.
# If the package servers can't be reached, the image still builds: only the backup button reports an error.
RUN (apt-get update && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 postgresql-client-17 postgresql-client-18) \
 || echo "WARNING: pg_dump was not installed; Download backup will not work in this build"; \
 rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
