/**
 * Transaction Storage Service
 * Keeps track of all detected transactions in memory and persists to PostgreSQL / Neon DB when configured
 */

const axios = require('axios');

class TransactionStorage {
  constructor(networkConfig, db = null) {
    this.transactions = [];
    this.networkConfig = networkConfig;
    this.db = db;
  }

  /**
   * Populate in-memory transactions cache from PostgreSQL if available
   */
  async loadFromDb() {
    if (!this.db) return;

    try {
      const result = await this.db.query(
        'SELECT * FROM transactions ORDER BY detected_at DESC'
      );

      if (result && result.rows) {
        this.transactions = result.rows.map(row => ({
          id: row.id,
          sessionId: row.session_id,
          txHash: row.tx_hash,
          fromAddress: row.from_address,
          toAddress: row.to_address,
          amount: row.amount ? row.amount.toString() : '0',
          currency: row.currency,
          network: row.network,
          confirmations: row.confirmations || 0,
          status: row.status,
          blockNumber: row.block_number ? parseInt(row.block_number, 10) : null,
          detectedAt: row.detected_at,
          confirmedAt: row.confirmed_at,
          updatedAt: row.updated_at
        }));
        console.log(`[TransactionStorage] Loaded ${this.transactions.length} transactions from database.`);
      }
    } catch (error) {
      console.error('[TransactionStorage] Failed to load transactions from database:', error.message);
    }
  }

  /**
   * Add a new transaction to the storage (cache & database)
   * @param {Object} transaction - Transaction object to store
   */
  async addTransaction(transaction) {
    // Check if transaction already exists in cache
    const existingTxIndex = this.transactions.findIndex(tx => tx.txHash === transaction.txHash);
    
    // Ensure we have all required fields with proper defaults
    const txData = {
      id: transaction.id || `tx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      sessionId: transaction.sessionId || null,
      txHash: transaction.txHash,
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress,
      amount: transaction.amount,
      currency: transaction.currency,
      network: transaction.network,
      confirmations: transaction.confirmations || 0,
      status: transaction.status || 'PENDING',
      blockNumber: transaction.blockNumber || null,
      detectedAt: transaction.detectedAt || new Date(),
      confirmedAt: transaction.confirmedAt || null,
      updatedAt: new Date()
    };
    
    if (existingTxIndex !== -1) {
      // Update existing transaction in cache
      this.transactions[existingTxIndex] = {
        ...this.transactions[existingTxIndex],
        ...txData
      };
    } else {
      // Add new transaction to cache
      this.transactions.push(txData);
    }

    // Persist to Neon DB if available
    if (this.db) {
      try {
        const queryText = `
          INSERT INTO transactions (
            id, session_id, tx_hash, from_address, to_address, amount,
            currency, network, confirmations, status, block_number,
            detected_at, confirmed_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (tx_hash) DO UPDATE SET
            confirmations = EXCLUDED.confirmations,
            status = EXCLUDED.status,
            block_number = COALESCE(EXCLUDED.block_number, transactions.block_number),
            confirmed_at = COALESCE(EXCLUDED.confirmed_at, transactions.confirmed_at),
            updated_at = NOW()
        `;
        const params = [
          txData.id,
          txData.sessionId,
          txData.txHash,
          txData.fromAddress,
          txData.toAddress,
          txData.amount,
          txData.currency,
          txData.network,
          txData.confirmations,
          txData.status,
          txData.blockNumber,
          txData.detectedAt,
          txData.confirmedAt,
          txData.updatedAt
        ];
        await this.db.query(queryText, params);
      } catch (dbError) {
        console.error('[TransactionStorage] Failed to persist transaction to database:', dbError.message);
      }
    }

    return txData;
  }

  /**
   * Get all stored transactions
   * @returns {Array} All transactions
   */
  getAllTransactions() {
    return this.transactions;
  }

  /**
   * Get transaction by hash
   * @param {string} txHash - Transaction hash to find
   * @returns {Object|null} Transaction or null if not found
   */
  getTransactionByHash(txHash) {
    return this.transactions.find(tx => tx.txHash === txHash) || null;
  }

  /**
   * Update transaction status by checking the blockchain explorer
   * @param {string} txHash - Transaction hash to update
   * @param {string} network - Network name (e.g., 'BEP20', 'POLYGON')
   * @returns {Promise<Object|null>} Updated transaction or null if not found
   */
  async updateTransactionStatus(txHash, network) {
    const txIndex = this.transactions.findIndex(tx => tx.txHash === txHash);
    if (txIndex === -1) return null;

    const tx = this.transactions[txIndex];
    const networkSettings = this.networkConfig[network];

    if (!networkSettings) {
      console.error(`Network ${network} not found in configuration`);
      return tx;
    }

    try {
      let apiUrl, params;
      const Web3 = require('web3');
      const web3 = new Web3(networkSettings.rpcUrl);

      // First, get current block number from the network
      const currentBlockNumber = await web3.eth.getBlockNumber();
      
      // Then check transaction receipt
      const receipt = await web3.eth.getTransactionReceipt(txHash);
      
      // Calculate confirmations if we have a receipt and block number
      let confirmations = 0;
      let status = tx.status;
      
      if (receipt) {
        // Calculate confirmations based on current block and transaction block
        confirmations = receipt.blockNumber ? currentBlockNumber - receipt.blockNumber + 1 : 0;
        
        // Update status based on receipt status and confirmations
        if (receipt.status) {
          if (confirmations >= networkSettings.requiredConfirmations) {
            status = 'CONFIRMED';
          } else {
            status = 'PENDING';
          }
        } else {
          status = 'FAILED';
        }
        
        // Update transaction
        const updatedTx = {
          ...tx,
          status,
          confirmations,
          blockNumber: receipt.blockNumber,
          confirmedAt: status === 'CONFIRMED' && !tx.confirmedAt ? new Date() : tx.confirmedAt,
          updatedAt: new Date()
        };
        
        this.transactions[txIndex] = updatedTx;

        // Persist status update to DB
        if (this.db) {
          try {
            await this.db.query(
              `UPDATE transactions 
               SET status = $1, confirmations = $2, block_number = $3, confirmed_at = $4, updated_at = NOW()
               WHERE tx_hash = $5`,
              [updatedTx.status, updatedTx.confirmations, updatedTx.blockNumber, updatedTx.confirmedAt, txHash]
            );
          } catch (err) {
            console.error('[TransactionStorage] Failed to update transaction in database:', err.message);
          }
        }

        return updatedTx;
      }
      
      // Fallback to explorer API if RPC doesn't provide enough info
      if (network === 'POLYGON' || network === 'BEP20' || network === 'BEP20_TESTNET') {
        apiUrl = networkSettings.explorerApiUrl;
        params = {
          module: 'transaction',
          action: 'gettxreceiptstatus',
          txhash: txHash,
          apikey: networkSettings.explorerApiKey
        };

        const response = await axios.get(apiUrl, { params });
        
        if (response.data.status === '1') {
          // Transaction confirmed according to explorer
          const updatedTx = {
            ...tx,
            status: 'CONFIRMED',
            confirmations: networkSettings.requiredConfirmations,
            confirmedAt: tx.confirmedAt || new Date(),
            updatedAt: new Date()
          };
          
          this.transactions[txIndex] = updatedTx;

          if (this.db) {
            try {
              await this.db.query(
                `UPDATE transactions 
                 SET status = $1, confirmations = $2, confirmed_at = $3, updated_at = NOW()
                 WHERE tx_hash = $4`,
                [updatedTx.status, updatedTx.confirmations, updatedTx.confirmedAt, txHash]
              );
            } catch (err) {
              console.error('[TransactionStorage] Failed to update transaction via explorer in DB:', err.message);
            }
          }

          return updatedTx;
        }
      }
      
      // No updates, return current transaction
      return tx;
    } catch (error) {
      console.error(`Error updating transaction status: ${error.message}`);
      return tx;
    }
  }

  /**
   * Update all transactions by checking blockchain explorers
   * @returns {Promise<Array>} Updated transactions
   */
  async updateAllTransactions() {
    const updatePromises = this.transactions
      .filter(tx => tx.network && this.networkConfig[tx.network]) // Only update transactions with valid network
      .map(tx => this.updateTransactionStatus(tx.txHash, tx.network));
    
    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }
    
    return this.transactions;
  }
}

module.exports = TransactionStorage;