FROM node:18-alpine

RUN apk add --no-cache netcat-openbsd && npm install -g pm2

WORKDIR /app

COPY package*.json ./
COPY *.js ./

RUN npm install --omit=dev

RUN addgroup -g 1001 -S nodejs \
  && adduser -S battleship -u 1001 \
  && chown -R battleship:nodejs /app
USER battleship

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD nc -z localhost 3000 || exit 1

CMD ["pm2-runtime", "start", "ecosystem.config.js"]
