FROM node:20-alpine

# Cài đặt Tailscale và iptables (cần thiết cho tun=userspace-networking nếu có fallback)
RUN apk update && apk add --no-cache curl iptables \
    && curl -fsSL https://tailscale.com/install.sh | sh

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
