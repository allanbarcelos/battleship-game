FROM node:18

RUN apt-get update && apt-get install -y \
    nginx supervisor libcairo2-dev libjpeg-dev libgif-dev librsvg2-dev libpango1.0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY api/package*.json ./
RUN npm install -g nodemon
RUN npm install
RUN npm rebuild @tensorflow/tfjs-node --build-from-source

COPY api/ .

COPY html /usr/share/nginx/html

COPY nginx/conf.d /etc/nginx/conf.d

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 80


# Iniciar supervisor
CMD ["/usr/bin/supervisord"]
