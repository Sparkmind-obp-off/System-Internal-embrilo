module.exports = {
  apps: [
    {
      name: 'embrilo-os',
      script: 'npx',
      args: 'wrangler pages dev dist --local --ip 0.0.0.0 --port 3000',
      env: { NODE_ENV: 'development' },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
