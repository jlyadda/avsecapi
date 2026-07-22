const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('./db');

const migrationsDirectory = path.join(__dirname, 'migrations');

const splitStatements = (sql) => (
  sql.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean)
);

const initializeDatabase = async () => {
  const connection = await db.getConnection();
  let lockAcquired = false;

  try {
    const [[lockResult]] = await connection.query("SELECT GET_LOCK('avsecapi_schema_migrations', 30) AS acquired");
    lockAcquired = lockResult.acquired === 1;
    if (!lockAcquired) throw new Error('Could not acquire the database migration lock.');

    await connection.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name VARCHAR(255) NOT NULL,
         checksum CHAR(64) NOT NULL,
         applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP(),
         PRIMARY KEY (name)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    const files = (await fs.readdir(migrationsDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const [existingRows] = await connection.execute(
        'SELECT checksum FROM schema_migrations WHERE name = ?',
        [file]
      );

      if (existingRows[0]) {
        if (existingRows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${file} has been modified.`);
        }
        continue;
      }

      for (const statement of splitStatements(sql)) {
        await connection.query(statement);
      }
      await connection.execute(
        'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
        [file, checksum]
      );
      console.log(`Applied migration ${file}`);
    }
  } finally {
    if (lockAcquired) {
      await connection.query("SELECT RELEASE_LOCK('avsecapi_schema_migrations')");
    }
    connection.release();
  }
};

module.exports = { initializeDatabase };
