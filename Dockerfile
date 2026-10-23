# Drupal MCP Connector — container image for the HTTPS (Streamable-HTTP) transport.
#
# Build:  docker build -t drupal-mcp-connector .
# Publish: each v* tag pushes ghcr.io/wilkes-liberty/drupal-mcp-connector:<version>
#          (signed; pin name@sha256:… — see docs/deployment.md).
# Run:    see docs/deployment.md (mount config + TLS certs; configure auth.issuer + auth.audience).
#
# The image ships only production deps + src/ + the example config. Provide the
# real config by mounting /app/config/config.json (or via env vars), and TLS via
# mounted certs referenced by TLS_CERT_PATH / TLS_KEY_PATH.

# Node 24 is the Active LTS line. Node 20 reached end-of-life and gets no more
# security fixes. The node:24-alpine tag tracks the newest 24.x patch, so a
# rebuild picks up the 2026-10-21 Node.js security release (fixed in 24.22.1;
# CVE-2026-111497 Brotli plus three High TLS/DNS bugs). Rebuild after any future
# Node security release; pin by digest if you need a reproducible image.
# https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
FROM node:24-alpine

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
