FROM node:20-alpine

# Cài đặt Tailscale (Không cài iptables để tránh Tailscale hijack traffic của Telegram)
RUN apk update && apk add --no-cache curl tailscale

# Tạo thư mục cho Tailscale socket & state
RUN mkdir -p /var/run/tailscale /var/cache/tailscale /var/lib/tailscale

WORKDIR /app

# Copy package info và cài đặt dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy mã nguồn
COPY . .

# Đảm bảo start.sh có quyền thực thi
RUN chmod +x /app/start.sh

EXPOSE 3386

# Dùng start.sh làm entrypoint
CMD ["/app/start.sh"]
