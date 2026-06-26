# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=24.13.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci

# Copy application code
COPY . .


# Final stage for app image
FROM base

# 우체국 SEED128 호출용 PHP 7.4 CLI 설치 (사장님 결정 2026-06-27).
# PHP 8.x 는 우체국 공식 SEED128.php (2016) 의 ConvertInt 함수에서 float overflow
# warning 발생 → 결과 0. PHP 7.4 에서만 정상 작동. Sury PHP repo 사용.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
        ca-certificates curl gnupg lsb-release && \
    curl -fsSL https://packages.sury.org/php/apt.gpg -o /etc/apt/trusted.gpg.d/php.gpg && \
    echo "deb https://packages.sury.org/php/ $(lsb_release -sc) main" > /etc/apt/sources.list.d/php.list && \
    apt-get update -qq && \
    apt-get install --no-install-recommends -y php7.4-cli && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    php7.4 --version

# PHP 실행 파일 path — seed128.js 의 PHP_BIN 환경변수가 이걸 가리킴
ENV PHP_BIN=/usr/bin/php7.4

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD [ "npm", "run", "start" ]
