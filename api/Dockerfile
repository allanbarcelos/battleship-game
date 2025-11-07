FROM node:18-alpine

RUN npm install -g pm2

WORKDIR /app

COPY package*.json ./
COPY *.js ./

RUN npm install --production

RUN addgroup -g 1001 -S nodejs
RUN adduser -S battleship -u 1001
RUN chown -R battleship:nodejs /app
USER battleship

EXPOSE 3000

CMD ["pm2-runtime", "start", "ecosystem.config.js"]