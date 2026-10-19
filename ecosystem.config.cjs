// Cấu hình pm2: giữ server luôn chạy, tự khởi động lại khi lỗi / khi VPS reboot
// Dùng: pm2 start ecosystem.config.cjs   |   pm2 reload api-server   |   pm2 logs api-server
module.exports = {
  apps: [
    {
      name: 'api-server',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,              // 1 tiến trình (bộ đếm giới hạn, lịch sử chat nằm trong RAM)
      autorestart: true,
      max_memory_restart: '400M',
      kill_timeout: 8000,        // cho server 8s ghi nốt log + số liệu key trước khi tắt
      restart_delay: 3000,
      env: { NODE_ENV: 'production' },
      time: true,                // thêm thời gian vào log
    },
  ],
};
