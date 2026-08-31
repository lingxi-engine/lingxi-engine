module.exports = {
  apps: [
    {
      name: 'lingxi',
      cwd: '/opt/lingxi-engine',
      script: './node_modules/tsx/dist/cli.mjs',
      args: '--no-cache index.ts',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        DEV_MODE: 'false',
        USE_DOCKER_SANDBOX: 'false',
        CODE_EXEC_ALLOW_VM: '1',
      },
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};