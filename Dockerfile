FROM ghcr.io/puppeteer/puppeteer:22.12.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./
# USER root
RUN npm ci
# USER node
COPY . .
CMD ["node", "index.js"]