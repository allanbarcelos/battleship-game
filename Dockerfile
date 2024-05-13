FROM node:18

# Install system dependencies for canvas
RUN apt-get update && apt-get install -y libcairo2-dev libjpeg-dev libgif-dev librsvg2-dev libpango1.0-dev

WORKDIR /usr/api

COPY api/package*.json ./

RUN npm install -g nodemon
RUN npm i
RUN npm rebuild @tensorflow/tfjs-node --build-from-source

COPY api/* .

# Copy the .env file to the Docker container
COPY .env .

ENV PORT $PORT
EXPOSE $PORT

CMD ["npm", "start"]
