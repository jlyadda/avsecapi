const app = require('./app');
const config = require('./config');
const db = require('./db');
const { initializeDatabase } = require('./databaseInitializer');

let server;

const start = async () => {
  await initializeDatabase();
  server = app.listen(config.PORT, () => {
    console.log(`Server running on port ${config.PORT}`);
  });
};

const shutdown = async (signal) => {
  console.log(`${signal} received; shutting down.`);
  if (!server) {
    await db.end();
    return;
  }
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(async (error) => {
  console.error('API startup failed:', error);
  await db.end();
  process.exit(1);
});
