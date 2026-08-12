FROM evil0ctal/douyin_tiktok_download_api:latest

# Cài đặt Node.js 20 và Tailscale (Debian trixie)
RUN apt-get update && apt-get install -y curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null && \
    curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list | tee /etc/apt/sources.list.d/tailscale.list && \
    apt-get update && apt-get install -y nodejs tailscale && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Tạo thư mục cho Tailscale socket & state
RUN mkdir -p /var/run/tailscale /var/cache/tailscale /var/lib/tailscale

# Đảm bảo làm việc trong thư mục bot
WORKDIR /bot

# Copy package info và cài đặt dependencies cho Bot
COPY package*.json ./
RUN npm install --omit=dev

# Copy mã nguồn bot
COPY . .

# Đảm bảo start.sh có quyền thực thi
RUN chmod +x /bot/start.sh

# Expose port của Bot (3386) và API (80)
EXPOSE 3386 80

# Dùng start.sh của bot làm entrypoint
CMD ["/bot/start.sh"]
