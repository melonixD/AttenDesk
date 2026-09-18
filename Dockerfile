FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates awscli && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
RUN mkdir -p /var/attendesk-backups && chown -R node:node /var/attendesk-backups
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node api ./api
USER node
EXPOSE 8787
CMD ["sh", "-c", "cd server && npm run migrate && npm start"]
