#!/bin/sh

# Khởi chạy Tailscale daemon ngầm ở chế độ userspace networking (Cần thiết cho PaaS/Render)
echo "[INFO] Starting tailscaled in userspace-networking mode..."
tailscaled --tun=userspace-networking --outbound-http-proxy-listen=localhost:1055 > /dev/null 2>&1 &

# Đợi daemon khởi động
sleep 3

# Xác thực bằng Auth Key nếu có
if [ -n "$TAILSCALE_AUTHKEY" ]; then
    echo "[INFO] Authenticating Tailscale with Auth Key..."
    # Tự động kết nối và dùng lubu01 làm Exit Node, chặn sửa DNS để tránh lỗi phân giải
    tailscale up --authkey="${TAILSCALE_AUTHKEY}" --hostname="render-bot-node" --exit-node=100.118.216.65 --accept-routes --accept-dns=false
else
    echo "[WARN] No TAILSCALE_AUTHKEY found in environment variables. Tailscale may not connect."
fi

# Chạy ứng dụng Python Douyin API ngầm
echo "[INFO] Starting Douyin API..."
cd /app
python3 start.py &

# Chạy ứng dụng Node.js Bot
echo "[INFO] Starting Node.js Bot..."
cd /bot
# Tự động ép tất cả traffic của Bot đi qua Tailscale daemon
export PROXY_URL=http://localhost:1055
exec node bot.js
