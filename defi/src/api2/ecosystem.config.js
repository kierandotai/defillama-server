// https://pm2.keymetrics.io/docs/usage/application-declaration/
const instances = Number(process.env.API2_INSTANCES) || 3;
const maxMemoryMB = Number(process.env.API2_MAX_MEMORY_MB) || 8120;

module.exports = {
  apps: [
    {
      name: 'api2-rest-server',
      script: './src/api2/index.ts', // Path to your main TypeScript file
      interpreter: 'node',
      args: '-r ts-node/register', // Use ts-node for running TypeScript files
      node_args: `--max-old-space-size=${maxMemoryMB}`,
      listen_timeout: 120_000, // Wait 120 seconds for the app to start
      kill_timeout: 10_000, // Wait 10 seconds for the app to start
      wait_ready: true, // Wait for the 'ready' signal
      instances,
      exec_mode: 'cluster', // Start in cluster mode
      env: {
        TS_NODE_TRANSPILE_ONLY: 'true', // Enable ts-node's transpile-only mode, setting it via args is not working for some reason
      },
    },
  ],
};