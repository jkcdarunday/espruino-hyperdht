# syntax=docker/dockerfile:1
# Build and export firmware:
# docker buildx build --output type=local,dest=out .
ARG IDF_IMAGE=espressif/idf:v5.5
FROM ${IDF_IMAGE} AS builder
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl git patch ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Match the component manager used for the successful C6 cross-build.
RUN /opt/esp/entrypoint.sh python -m pip install --no-cache-dir idf-component-manager==2.2.2
WORKDIR /project
# Cache pinned source downloads separately from application changes.
COPY dependencies.json ./
COPY scripts/fetch-deps.py ./scripts/fetch-deps.py
RUN python3 -c 'import tarfile; assert hasattr(tarfile, "data_filter"), "Python with tarfile data filter required"' \
    && python3 scripts/fetch-deps.py
COPY . .
ARG SOURCE_REVISION=local
ENV SOURCE_REVISION=${SOURCE_REVISION}
ARG HYPERDHT_CHIP=c6
ENV HYPERDHT_CHIP=${HYPERDHT_CHIP}
# Docker RUN does not invoke the base image ENTRYPOINT. Activate IDF explicitly.
RUN /opt/esp/entrypoint.sh bash scripts/docker-build.sh

# Artifact-only stage for BuildKit's local exporter; not a runnable container.
FROM scratch AS firmware
COPY --from=builder /artifacts/ /
