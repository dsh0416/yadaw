FROM ubuntu:24.04

ARG MISE_VERSION=2026.7.13

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.local/share/mise/shims:/root/.local/bin:/usr/local/bin/mise/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      clang \
      curl \
      dbus-x11 \
      gdb \
      git \
      libasound2-dev \
      libcairo2-dev \
      libfontconfig1-dev \
      libfreetype-dev \
      libglib2.0-dev \
      libgtkmm-3.0-dev \
      libpango1.0-dev \
      libx11-dev \
      libx11-xcb-dev \
      libxcb1-dev \
      libxcb-cursor-dev \
      libxcb-keysyms1-dev \
      libxcb-util-dev \
      libxcb-xkb-dev \
      libxcursor-dev \
      libxi-dev \
      libxinerama-dev \
      libxkbcommon-dev \
      libxkbcommon-x11-dev \
      libxrandr-dev \
      libwayland-dev \
      libopenjp2-tools \
      ninja-build \
      pkg-config \
      procps \
      python3 \
      rsync \
      sudo \
      wayland-protocols \
      xauth \
      xvfb \
    && curl --fail --location --retry 3 \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.gz" \
      --output /tmp/mise.tar.gz \
    && tar --extract --gzip --file /tmp/mise.tar.gz --directory /usr/local/bin mise \
    && rm /tmp/mise.tar.gz \
    && rm --recursive --force /var/lib/apt/lists/*

# GitHub's Ubuntu runner already contains SQLite headers. The standalone
# VSTGUI target pulled in by the official fixture expects them at configure
# time, so the local reproduction image has to declare that implicit runner
# dependency explicitly.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      libnspr4 \
      libnss3 \
      libsqlite3-dev \
      unzip \
    && rm --recursive --force /var/lib/apt/lists/*

COPY .github/docker/vst3-editor-linux-entrypoint.sh /usr/local/bin/heron-vst3-editor-linux

WORKDIR /work

ENTRYPOINT ["/usr/local/bin/heron-vst3-editor-linux"]
