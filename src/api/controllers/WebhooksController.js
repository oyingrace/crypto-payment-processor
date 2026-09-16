/**
 * Webhooks API Controller
 * Handles API endpoints for webhooks with PostgreSQL / Neon DB persistence
 */
const crypto = require('crypto');
const { ValidationError, NotFoundError } = require('../utils/errors');

class WebhooksController {
  /**
   * Constructor for the webhooks controller
   * @param {Object} db - Database connection object
   */
  constructor(db) {
    this.db = db;
    this.webhooks = []; // In-memory fallback
  }

  /**
   * Create a webhook
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async createWebhook(req, res, next) {
    try {
      const { url, events, description } = req.body;
      
      // Validate required fields
      if (!url) {
        throw new ValidationError('URL is required', { url: ['URL is required'] });
      }
      
      if (!events || !Array.isArray(events) || events.length === 0) {
        throw new ValidationError('Events are required', { events: ['Events must be a non-empty array'] });
      }
      
      // Validate URL format
      try {
        new URL(url);
      } catch (error) {
        throw new ValidationError('Invalid URL format', { url: ['Invalid URL format'] });
      }
      
      // Generate a webhook ID
      const id = crypto.randomUUID();
      
      // Generate a webhook secret
      const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
      
      // Create the webhook
      const webhook = {
        id,
        url,
        events,
        description: description || '',
        secret,
        created_at: new Date()
      };
      
      this.webhooks.push(webhook);

      if (this.db) {
        try {
          await this.db.query(
            `INSERT INTO webhooks (id, url, events, description, secret, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [webhook.id, webhook.url, webhook.events, webhook.description, webhook.secret, webhook.created_at]
          );
        } catch (dbErr) {
          console.error('[WebhooksController] Failed to persist webhook to DB:', dbErr.message);
        }
      }
      
      res.status(200).json(webhook);
    } catch (error) {
      next(error);
    }
  }

  /**
   * List webhooks
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async listWebhooks(req, res, next) {
    try {
      if (this.db) {
        try {
          const result = await this.db.query('SELECT * FROM webhooks ORDER BY created_at DESC');
          if (result && result.rows) {
            return res.status(200).json({
              data: result.rows
            });
          }
        } catch (dbErr) {
          console.error('[WebhooksController] Failed to query webhooks from DB:', dbErr.message);
        }
      }

      res.status(200).json({
        data: this.webhooks
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a webhook
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async deleteWebhook(req, res, next) {
    try {
      const { id } = req.params;
      
      this.webhooks = this.webhooks.filter(w => w.id !== id);

      if (this.db) {
        try {
          await this.db.query('DELETE FROM webhooks WHERE id = $1', [id]);
        } catch (dbErr) {
          console.error('[WebhooksController] Failed to delete webhook from DB:', dbErr.message);
        }
      }
      
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }
}

module.exports = WebhooksController;
