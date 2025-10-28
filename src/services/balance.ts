import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, createUserBalanceKey } from '../db/config.js';
import type { BalanceItem, BalanceResponse } from '../types/index.js';
import { BalanceError } from '../types/index.js';

export async function getCurrentBalance(userId: string): Promise<BalanceResponse> {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
        throw new BalanceError('Invalid userId: must be a non-empty string', 'INVALID_USER_ID');
    }

    try {
        const key = createUserBalanceKey(userId);

        const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: key,
        }));

        if (!result.Item) {
            // New user - return zero balance
            return {
                userId,
                balance: 0,
            };
        }

        const balanceItem = result.Item as BalanceItem;

        return {
            userId,
            balance: balanceItem.balance,
        };
    } catch (error) {
        if (error instanceof BalanceError) {
            throw error;
        }

        console.error('Error retrieving balance:', error);
        throw new BalanceError(
            `Failed to retrieve balance for user ${userId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            'DATABASE_ERROR'
        );
    }
}
