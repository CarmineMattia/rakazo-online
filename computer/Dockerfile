# Local Rakazo computer image: stock desktop + file UI + agent CLI toolkit.
# Omarchy/Hyprland is a full human desktop — not compatible with Rakazo's Xvfb/noVNC contract.
FROM ghcr.io/elie222/rakazo/computer:edge

USER root

# Desktop + common agent CLI (Debian packages)
RUN set -eux; \
  apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    pcmanfm \
    mousepad \
    nano \
    lxde-icon-theme \
    gvfs \
    shared-mime-info \
    git \
    curl \
    ca-certificates \
    wget \
    jq \
    unzip \
    zip \
    ripgrep \
    fd-find \
    tree \
    file \
    less \
    openssh-client \
    build-essential \
    python3-pip \
    python3-venv \
    npm \
    sqlite3 \
    rsync \
    tmux \
    procps \
    psmisc \
    gnupg \
  ; \
  rm -rf /var/lib/apt/lists/*; \
  ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
  mkdir -p /etc/xdg/xdg-rakazo/applications; \
  printf '%s\n' \
    '[Default Applications]' \
    'text/plain=mousepad.desktop' \
    'text/x-log=mousepad.desktop' \
    'application/x-zerosize=mousepad.desktop' \
    > /etc/xdg/xdg-rakazo/applications/mimeapps.list; \
  mkdir -p /etc/skel/.config /home/rakazo/.config; \
  cp /etc/xdg/xdg-rakazo/applications/mimeapps.list /etc/skel/.config/mimeapps.list; \
  cp /etc/xdg/xdg-rakazo/applications/mimeapps.list /home/rakazo/.config/mimeapps.list; \
  chown -R 1000:1000 /home/rakazo/.config || true

# pnpm (Debian node has no corepack), Bun, GitHub CLI
RUN set -eux; \
  npm install -g pnpm@latest; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) bun_arch=x64 ;; \
    arm64) bun_arch=aarch64 ;; \
    *) echo "unsupported arch: $arch"; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip; \
  unzip -qo /tmp/bun.zip -d /tmp; \
  install -m 755 "/tmp/bun-linux-${bun_arch}/bun" /usr/local/bin/bun; \
  ln -sf /usr/local/bin/bun /usr/local/bin/bunx; \
  rm -rf /tmp/bun.zip "/tmp/bun-linux-${bun_arch}"; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=${arch} signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh; \
  rm -rf /var/lib/apt/lists/*; \
  node -v; npm -v; pnpm -v; bun -v; gh --version

# Stock Fluxbox menu uses "xterm -bg #111113 ..."; '#' starts a Fluxbox comment,
# so Terminal never launches. Use wrappers with safe colors + window raise.
COPY rakazo-terminal rakazo-files rakazo-edit /usr/local/bin/
RUN chmod 755 /usr/local/bin/rakazo-terminal /usr/local/bin/rakazo-files /usr/local/bin/rakazo-edit
COPY fluxbox-menu /etc/rakazo/fluxbox/menu
