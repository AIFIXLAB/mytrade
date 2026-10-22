# Runs the bot 24/7 on any VPS / Railway / Fly.io / Render (as a background worker, not a web service).
FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
COPY wallets.json* wallets.example.json ./
ENV NODE_ENV=production
# state survives restarts if you mount a volume at /app/data
VOLUME ["/app/data"]
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/index.ts"]
