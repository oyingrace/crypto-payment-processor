/**
 * Database Module (PostgreSQL / Neon DB)
 * Provides connection pooling, automatic schema initialization, and query helpers.
 */
const { Pool } = require('pg');

let pool = null;
let isInitialized = false;

/**
 * Get or create the PostgreSQL connection pool
 * @returns {Pool|null}
 */
function getPool() {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.DATABASE_URL;
  const host = process.env.DB_HOST;

  if (!connectionString && !host) {
    return null;
  }

  const config = connectionString
    ? {
        connectionString,
        ssl: {
          rejectUnauthorized: false
        }
      }
    : {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: {
          rejectUnauthorized: false
        }
      };

  pool = new Pool({
    ...config,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (err) => {
    console.error('[Database] Unexpected error on idle client:', err.message);
  });

  return pool;
}

/**
 * Execute a SQL query
 * @param {string} text - SQL query string
 * @param {Array} params - Parameter array
 * @returns {Promise<Object>}
 */
async function query(text, params = []) {
  const p = getPool();
  if (!p) {
    return { rows: [], rowCount: 0 };
  }
  return p.query(text, params);
}

/**
 * Initialize database schema if connected
 * Creates payment_sessions, transactions, listener_state, and webhooks tables
 */
async function initDb() {
  const p = getPool();
  if (!p) {
    console.log('[Database] No DATABASE_URL or DB_HOST configured. Running in in-memory mode.');
    return false;
  }

  try {
    const client = await p.connect();
    try {
      console.log('[Database] Connected to PostgreSQL (Neon DB). Initializing schema...');

      await client.query(`
        -- Payment Sessions
        CREATE TABLE IF NOT EXISTS payment_sessions (
          id VARCHAR(64) PRIMARY KEY,
          amount NUMERIC(36, 18) NOT NULL,
          currency VARCHAR(16) NOT NULL,
          network VARCHAR(32) NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
          recipient_address VARCHAR(128),
          client_reference_id VARCHAR(128),
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          completed_at TIMESTAMP WITH TIME ZONE
        );

        -- Detected & Verified Transactions
        CREATE TABLE IF NOT EXISTS transactions (
          id VARCHAR(64) PRIMARY KEY,
          session_id VARCHAR(64) REFERENCES payment_sessions(id) ON DELETE SET NULL,
          tx_hash VARCHAR(128) UNIQUE NOT NULL,
          from_address VARCHAR(128) NOT NULL,
          to_address VARCHAR(128) NOT NULL,
          amount NUMERIC(36, 18) NOT NULL,
          currency VARCHAR(16) NOT NULL,
          network VARCHAR(32) NOT NULL,
          confirmations INTEGER DEFAULT 0,
          status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
          block_number BIGINT,
          detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          confirmed_at TIMESTAMP WITH TIME ZONE,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Blockchain Listener State
        CREATE TABLE IF NOT EXISTS listener_state (
          network VARCHAR(32) PRIMARY KEY,
          last_checked_block BIGINT NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Webhooks
        CREATE TABLE IF NOT EXISTS webhooks (
          id VARCHAR(64) PRIMARY KEY,
          url TEXT NOT NULL,
          events TEXT[] NOT NULL,
          description TEXT,
          secret VARCHAR(128) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `);

      isInitialized = true;
      console.log('[Database] Schema initialized successfully.');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[Database] Schema initialization failed:', error.message);
    throw error;
  }
}

/**
 * Check if the database connection is active
 * @returns {boolean}
 */
function isConnected() {
  return pool !== null;
}

/**
 * Close database pool
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    isInitialized = false;
  }
}

module.exports = {
  getPool,
  query,
  initDb,
  isConnected,
  close
};
