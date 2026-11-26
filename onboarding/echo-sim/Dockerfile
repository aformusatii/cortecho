# The simulated Echo Dot: the existing FakeEcho (apps/api/src/esphome) behind a
# small control API. The build context is the repository root so the image can
# copy exactly the source files FakeEcho needs and the spoken fixture.
FROM node:24-slim

WORKDIR /app

COPY apps/api/package.json ./apps/api/
COPY apps/api/src/esphome/fake-echo.ts apps/api/src/esphome/framing.ts apps/api/src/esphome/messages.ts \
  apps/api/src/esphome/noise.ts apps/api/src/esphome/protobuf.ts ./apps/api/src/esphome/
COPY apps/api/src/pipeline/audio.ts ./apps/api/src/pipeline/
COPY onboarding/echo-sim/package.json onboarding/echo-sim/main.ts onboarding/echo-sim/control.ts \
  onboarding/echo-sim/echo-host.ts onboarding/echo-sim/fixture.ts ./onboarding/echo-sim/
COPY onboarding/fixtures/what-time-is-it.wav ./onboarding/fixtures/

EXPOSE 26053 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "onboarding/echo-sim/main.ts"]
