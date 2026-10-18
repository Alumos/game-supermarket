FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Alumos/game-supermarket"
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    SUPERMARKET_DATA_DIR=/app/data \
    SUPERMARKET_LAN_DISCOVERY=0 \
    SUPERMARKET_LOG_TEACHER_KEY=0

# The app uses only Node built-ins. Copy only runtime files, never local records.
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node shared ./shared
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
