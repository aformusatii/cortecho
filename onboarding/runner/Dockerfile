# Playwright drives the deployed Cortecho by IP on purpose: the wizard derives
# the scan hint and the reply address from the page's origin. The build context
# is the repository root so the image can also carry summary.ts.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /tests

COPY onboarding/runner/package.json ./
RUN npm install --no-audit --no-fund

COPY onboarding/runner/playwright.config.ts ./
COPY onboarding/runner/specs ./specs
COPY onboarding/runner/lib ./lib
COPY onboarding/scripts/summary.ts ./summary.ts

RUN mkdir -p /out/steps /out/media /out/blobs /out/artifacts /out/report

CMD ["sleep", "infinity"]
