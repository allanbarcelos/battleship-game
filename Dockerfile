FROM node:18 AS builder

RUN apt-get update && apt-get install -y \
  libcairo2-dev libjpeg-dev libgif-dev librsvg2-dev libpango1.0-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY api/package*.json ./
RUN npm install -g nodemon
RUN npm install
RUN npm rebuild @tensorflow/tfjs-node --build-from-source

COPY api/ .

FROM nginx:latest

COPY --from=builder /usr/src/app /usr/src/app

COPY html /usr/share/nginx/html

COPY nginx/conf.d /etc/nginx/conf.d

EXPOSE 80

RUN apt-get update && apt-get install -y supervisor && mkdir -p /var/log/supervisor

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

CMD ["/usr/bin/supervisord"]
