/**
 * Payment Session Manager
 * This module handles the creation and management of payment sessions with PostgreSQL / Neon DB persistence
 */
const crypto = require('crypto');
const AddressGenerator = require('./AddressGenerator');

class PaymentSessionManager {
  /**
   * Constructor for the payment session manager
   * @param {Object} db - Database connection object
   * @param {Object} config - Configuration object
   */
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.addressGenerator = new AddressGenerator(db);
    this.sessions = new Map(); // In-memory cache & fallback
  }

  /**
   * Create a new payment session
   * @param {Object} data - Payment session data
   * @returns {Promise<Object>} - The created payment session
   */
  async createSession(data) {
    try {
      // Validate input data
      this.validateSessionData(data);
      
      // Generate a unique session ID
      const sessionId = crypto.randomUUID();
      
      // Calculate expiration time
      const expirationMinutes = data.expiration_minutes || 30;
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + expirationMinutes);
      
      // Generate a payment address for this session
      const address = await this.addressGenerator.generateAddress(data.network, sessionId);

      // Create the session record
      const session = {
        id: sessionId,
        amount: data.amount,
        currency: data.currency,
        network: data.network,
        status: 'PENDING',
        created_at: new Date(),
        expires_at: expiresAt,
        completed_at: null,
        client_reference_id: data.client_reference_id || null,
        address: address,
        metadata: data.metadata || {}
      };
      
      // Save the session to the database / memory
      await this.saveSession(session);
      
      return session;
    } catch (error) {
      console.error('Failed to create payment session:', error);
      throw error;
    }
  }

  /**
   * Validate payment session data
   * @param {Object} data - Payment session data
   * @throws {Error} - If validation fails
   */
  validateSessionData(data) {
    if (!data.amount || isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) {
      throw new Error('Amount is required and must be a positive number');
    }
    
    if (!data.currency) {
      throw new Error('Currency is required');
    }
    
    if (!data.network) {
      throw new Error('Network is required');
    }
  }

  /**
   * Save a session to the database
   * @param {Object} session - The session to save
   * @returns {Promise<Object>}
   */
  async saveSession(session) {
    this.sessions.set(session.id, session);

    if (this.db) {
      try {
        const queryText = `
          INSERT INTO payment_sessions (
            id, amount, currency, network, status, recipient_address,
            client_reference_id, metadata, created_at, expires_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            recipient_address = COALESCE(EXCLUDED.recipient_address, payment_sessions.recipient_address),
            completed_at = EXCLUDED.completed_at,
            metadata = EXCLUDED.metadata
        `;
        const params = [
          session.id,
          session.amount,
          session.currency,
          session.network,
          session.status,
          session.address || null,
          session.client_reference_id || null,
          JSON.stringify(session.metadata || {}),
          session.created_at,
          session.expires_at,
          session.completed_at
        ];
        await this.db.query(queryText, params);
      } catch (err) {
        console.error('[PaymentSessionManager] Error persisting session to database:', err.message);
      }
    }

    return session;
  }

  /**
   * Get a payment session by ID
   * @param {string} sessionId - The payment session ID
   * @returns {Promise<Object|null>} - The payment session or null if not found
   */
  async getSession(sessionId) {
    if (!sessionId) return null;

    if (this.db) {
      try {
        const result = await this.db.query(
          'SELECT * FROM payment_sessions WHERE id = $1',
          [sessionId]
        );

        if (result && result.rows && result.rows.length > 0) {
          const row = result.rows[0];
          const session = {
            id: row.id,
            amount: row.amount ? row.amount.toString() : '0',
            currency: row.currency,
            network: row.network,
            status: row.status,
            created_at: row.created_at,
            expires_at: row.expires_at,
            completed_at: row.completed_at,
            client_reference_id: row.client_reference_id,
            address: row.recipient_address,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {})
          };
          this.sessions.set(session.id, session);
          return session;
        }
      } catch (err) {
        console.error('[PaymentSessionManager] Error fetching session from DB:', err.message);
      }
    }

    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    return null;
  }

  /**
   * Update a payment session
   * @param {string} sessionId - The payment session ID
   * @param {Object} updates - The updates to apply
   * @returns {Promise<Object|null>} - The updated session or null if not found
   */
  async updateSession(sessionId, updates) {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    
    // Apply updates to the session
    const updatedSession = {
      ...session,
      ...updates,
      metadata: {
        ...(session.metadata || {}),
        ...(updates.metadata || {})
      }
    };

    this.sessions.set(sessionId, updatedSession);

    if (this.db) {
      try {
        await this.db.query(
          `UPDATE payment_sessions
           SET status = $1, completed_at = $2, metadata = $3
           WHERE id = $4`,
          [
            updatedSession.status,
            updatedSession.completed_at || null,
            JSON.stringify(updatedSession.metadata || {}),
            sessionId
          ]
        );
      } catch (err) {
        console.error('[PaymentSessionManager] Error updating session in DB:', err.message);
      }
    }
    
    return updatedSession;
  }

  /**
   * Mark a payment session as expired
   * @param {string} sessionId - The payment session ID
   * @returns {Promise<Object|null>} - The updated session or null if not found
   */
  async expireSession(sessionId) {
    return this.updateSession(sessionId, {
      status: 'EXPIRED'
    });
  }

  /**
   * Mark a payment session as completed
   * @param {string} sessionId - The payment session ID
   * @param {string} transactionId - The transaction ID
   * @returns {Promise<Object|null>} - The updated session or null if not found
   */
  async completeSession(sessionId, transactionId) {
    return this.updateSession(sessionId, {
      status: 'COMPLETED',
      completed_at: new Date(),
      metadata: {
        transaction_id: transactionId
      }
    });
  }

  /**
   * Recreate an expired session
   * @param {string} sessionId - The original session ID
   * @returns {Promise<Object>} - The new payment session
   */
  async recreateSession(sessionId) {
    try {
      const originalSession = await this.getSession(sessionId);
      
      if (!originalSession) {
        throw new Error(`Session ${sessionId} not found`);
      }
      
      if (originalSession.status !== 'EXPIRED') {
        throw new Error(`Session ${sessionId} is not expired`);
      }
      
      const newSession = await this.createSession({
        amount: originalSession.amount,
        currency: originalSession.currency,
        network: originalSession.network,
        client_reference_id: originalSession.client_reference_id,
        metadata: {
          ...originalSession.metadata,
          original_session_id: sessionId
        }
      });
      
      return {
        ...newSession,
        original_session_id: sessionId
      };
    } catch (error) {
      console.error(`Failed to recreate session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * List payment sessions with optional filtering
   * @param {Object} filters - Filter criteria
   * @returns {Promise<Array>} - Array of payment sessions
   */
  async listSessions(filters = {}) {
    if (this.db) {
      try {
        let queryText = 'SELECT * FROM payment_sessions';
        const params = [];
        const conditions = [];

        if (filters.status) {
          params.push(filters.status);
          conditions.push(`status = $${params.length}`);
        }

        if (filters.network) {
          params.push(filters.network);
          conditions.push(`network = $${params.length}`);
        }

        if (conditions.length > 0) {
          queryText += ' WHERE ' + conditions.join(' AND ');
        }

        queryText += ' ORDER BY created_at DESC LIMIT 100';

        const result = await this.db.query(queryText, params);
        if (result && result.rows) {
          return result.rows.map(row => ({
            id: row.id,
            amount: row.amount ? row.amount.toString() : '0',
            currency: row.currency,
            network: row.network,
            status: row.status,
            created_at: row.created_at,
            expires_at: row.expires_at,
            completed_at: row.completed_at,
            client_reference_id: row.client_reference_id,
            address: row.recipient_address,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {})
          }));
        }
      } catch (err) {
        console.error('[PaymentSessionManager] Error querying sessions from DB:', err.message);
      }
    }

    // In-memory fallback
    const sessions = Array.from(this.sessions.values());
    if (filters.status) {
      return sessions.filter(s => s.status === filters.status);
    }
    return sessions;
  }

  /**
   * Check for expired sessions and update their status
   * @returns {Promise<number>} - Number of sessions expired
   */
  async checkExpiredSessions() {
    try {
      if (this.db) {
        const result = await this.db.query(
          `UPDATE payment_sessions
           SET status = 'EXPIRED'
           WHERE status = 'PENDING' AND expires_at < NOW()`
        );
        return result.rowCount || 0;
      }

      let expiredCount = 0;
      const now = new Date();
      for (const [id, session] of this.sessions.entries()) {
        if (session.status === 'PENDING' && new Date(session.expires_at) < now) {
          session.status = 'EXPIRED';
          expiredCount++;
        }
      }
      return expiredCount;
    } catch (error) {
      console.error('Failed to check expired sessions:', error);
      throw error;
    }
  }
}

module.exports = PaymentSessionManager;
