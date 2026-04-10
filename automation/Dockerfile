FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV="production"

FROM base AS build
RUN apt-get update -qq && apt-get install --no-install-recommends -y build-essential python-is-python3
COPY package-lock.json package.json ./
RUN npm ci --include=dev
COPY . .
RUN npx tsc

FROM base
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "dist/index.js"]
