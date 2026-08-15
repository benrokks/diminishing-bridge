FROM node:20-alpine

WORKDIR /app

# Install production deps first so Docker can cache this layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Everything lives in one flat directory (see the note at the top of server.js).
COPY *.js *.html *.css ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
