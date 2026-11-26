FROM node:24-slim

WORKDIR /app
COPY onboarding/openai-gw/server.ts onboarding/openai-gw/package.json ./

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.ts"]
