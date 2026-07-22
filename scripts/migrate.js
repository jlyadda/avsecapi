const db = require('../db');
const { initializeDatabase } = require('../databaseInitializer');

initializeDatabase()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.end());
