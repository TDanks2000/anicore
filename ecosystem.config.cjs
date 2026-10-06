const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "anicore-api",
      cwd: path.join(__dirname, "apps/api"),
      script: "src/index.ts",
      interpreter: "bun",
      // The API owns the sync scheduler; keep a single instance.
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      min_uptime: "10s",
      max_restarts: 10,
      // Sync children have up to five seconds to stop before the database closes.
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "anicore-web",
      cwd: __dirname,
      script: "serve",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      min_uptime: "10s",
      max_restarts: 10,
      time: true,
      env: {
        NODE_ENV: "production",
        PM2_SERVE_PATH: path.join(__dirname, "apps/web/dist"),
        PM2_SERVE_PORT: 5173,
        PM2_SERVE_SPA: "true",
        PM2_SERVE_HOMEPAGE: "/index.html",
      },
    },
  ],
};
