import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { docClient, TABLE_NAME, createUserBalanceKey, createTransactionKey, createIdempotencyKey, BALANCE_TTL_DAYS } from '../db/config.js';
import type {
    TransactRequest,
    TransactionResponse,
    BalanceItem,
    TransactionItem,
    IdempotencyItem,
} from '../types/index.js';
import {
    BalanceError,
    InsufficientFundsError,
    InvalidAmountError,
    RaceConditionError
} from '../types/index.js';

export async function transact(request: TransactRequest): Promise<TransactionResponse> {
    const { idempotentKey, userId, amount: amountStr, type } = request;

  // Input validation
  if (!idempotentKey || typeof idempotentKey !== 'string' || idempotentKey.trim() === '') {
    throw new BalanceError('Invalid idempotentKey: must be a non-empty string', 'INVALID_IDEMPOTENT_KEY');
  }

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new BalanceError('Invalid userId: must be a non-empty string', 'INVALID_USER_ID');
  }

  if (!amountStr || typeof amountStr !== 'string' || amountStr.trim() === '') {
    throw new InvalidAmountError(amountStr || '');
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    throw new InvalidAmountError(amountStr);
  }

  if (!['credit', 'debit'].includes(type)) {
    throw new BalanceError('Invalid type: must be either "credit" or "debit"', 'INVALID_TRANSACTION_TYPE');
  }

    try {
        // Step 1: Check idempotency - has this transaction already been processed?
        const idempotencyKey = createIdempotencyKey(idempotentKey);
        const existingTransaction = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: idempotencyKey,
        }));

        if (existingTransaction.Item) {
            // Transaction already processed - return the previous result
            const idempotencyItem = existingTransaction.Item as IdempotencyItem;
            return {
                success: idempotencyItem.status === 'completed',
                idempotentKey,
                userId: idempotencyItem.userId,
                amount: idempotencyItem.amount,
                type: idempotencyItem.type,
                newBalance: idempotencyItem.newBalance,
                message: idempotencyItem.status === 'completed'
                    ? 'Transaction already processed (idempotent)'
                    : 'Transaction previously failed',
            };
        }

        // Step 2: Get current balance
        const balanceKey = createUserBalanceKey(userId);
        const balanceResult = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: balanceKey,
        }));

        let currentBalance = 0;
        let currentVersion = 0;

        if (balanceResult.Item) {
            const balanceItem = balanceResult.Item as BalanceItem;
            currentBalance = balanceItem.balance;
            currentVersion = balanceItem.version;
        }

        // Step 3: Calculate new balance
        let newBalance: number;
        if (type === 'credit') {
            newBalance = currentBalance + amount;
        } else { // debit
            newBalance = currentBalance - amount;
            if (newBalance < 0) {
                throw new InsufficientFundsError(userId, currentBalance, amount);
            }
        }

        // Step 4: Prepare transaction items
        const timestamp = new Date().toISOString();
        const transactionKey = createTransactionKey(userId, timestamp, idempotentKey);

        const balanceItem: BalanceItem = {
            ...balanceKey,
            userId,
            balance: newBalance,
            version: currentVersion + 1,
            createdAt: balanceResult.Item?.createdAt || timestamp,
            updatedAt: timestamp,
        };

        const transactionItem: TransactionItem = {
            ...transactionKey,
            userId,
            idempotentKey,
            amount,
            type,
            status: 'completed',
            timestamp,
            balanceAfter: newBalance,
        };

        const idempotencyItem: IdempotencyItem = {
            ...idempotencyKey,
            idempotentKey,
            userId,
            amount: amountStr,
            type,
            newBalance,
            status: 'completed',
            timestamp,
            ttl: Math.floor(Date.now() / 1000) + (BALANCE_TTL_DAYS * 24 * 60 * 60), // TTL in seconds
        };

        // Step 5: Execute atomic transaction
        const transactItems = [
            {
                Put: {
                    TableName: TABLE_NAME,
                    Item: balanceItem,
                    ConditionExpression: 'attribute_not_exists(PK) OR version = :currentVersion',
                    ExpressionAttributeValues: {
                        ':currentVersion': currentVersion,
                    },
                },
            },
            {
                Put: {
                    TableName: TABLE_NAME,
                    Item: transactionItem,
                },
            },
            {
                Put: {
                    TableName: TABLE_NAME,
                    Item: idempotencyItem,
                },
            },
        ];

        try {
            await docClient.send(new TransactWriteCommand({
                TransactItems: transactItems,
            }));
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                // Race condition - balance was modified by another transaction
                throw new RaceConditionError(userId);
            }
            throw error;
        }

        return {
            success: true,
            idempotentKey,
            userId,
            amount: amountStr,
            type,
            newBalance,
            message: 'Transaction completed successfully',
        };

    } catch (error) {
        // Handle idempotency record for failed transactions (except for validation errors)
        if (!(error instanceof BalanceError) || error.code !== 'INVALID_IDEMPOTENT_KEY' && error.code !== 'INVALID_USER_ID' && error.code !== 'INVALID_AMOUNT_FORMAT' && error.code !== 'INVALID_TRANSACTION_TYPE') {
            try {
                const timestamp = new Date().toISOString();
                const failedIdempotencyItem: IdempotencyItem = {
                    ...createIdempotencyKey(idempotentKey),
                    idempotentKey,
                    userId,
                    amount: amountStr,
                    type,
                    newBalance: 0, // Failed transactions don't change balance
                    status: 'failed',
                    timestamp,
                    ttl: Math.floor(Date.now() / 1000) + (BALANCE_TTL_DAYS * 24 * 60 * 60),
                };

                await docClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: failedIdempotencyItem,
                }));
            } catch (idempotencyError) {
                console.error('Failed to record failed transaction:', idempotencyError);
                // Don't throw here - we want to return the original error
            }
        }

        if (error instanceof BalanceError) {
            throw error;
        }

        console.error('Error processing transaction:', error);
        throw new BalanceError(
            `Transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            'TRANSACTION_ERROR'
        );
    }
}
