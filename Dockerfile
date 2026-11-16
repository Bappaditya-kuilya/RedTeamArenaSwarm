FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (including dev deps needed for build/types where applicable)
COPY package.json package-lock.json* bun.lock* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --legacy-peer-deps; fi

# Copy source and build frontend
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

# Full Node backend (clone, git, tsc/tests, SSE) - requires adequate Space hardware for heavy repos
CMD ["npm", "start"]
