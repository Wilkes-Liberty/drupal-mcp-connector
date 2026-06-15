# drupal-mcp-connector — container image for the HTTPS (Streamable-HTTP) transport.
#
# Build:  docker build -t drupal-mcp-connector .
# Run:    see docs/deployment.md (mount config + TLS certs, set MCP_AUTH_TOKEN).
#
# The image ships only production deps + src/ + the example config. Provide the
# real config by mounting /app/config/config.json (or via env vars), and TLS via
# mounted certs referenced by TLS_CERT_PATH / TLS_KEY_PATH.

FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source + example config (real config.json is mounted at runtime).
COPY src ./src
COPY config/config.example.json ./config/config.example.json

# Run as the built-in unprivileged user.
USER node

ENV MCP_TRANSPORT=https \
    MCP_PORT=3443
EXPOSE 3443

# Liveness probe: TCP connect to the listen port (no TLS termination here, so we
# don't disable certificate verification). For a deeper L7 check, point your
# orchestrator at GET /health using the cert's real hostname.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('net').connect({host:'localhost',port:process.env.MCP_PORT||3443},function(){this.end();process.exit(0)}).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
