import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getCurrentBalance } from '../services/balance.js';
import { docClient, TABLE_NAME, createUserBalanceKey } from '../db/config.js';
import { BalanceError } from '../types/index.js';

describe('getCurrentBalance', () => {
    const testUserId = 'test-user-balance';
    const testBalance = 500;

    beforeEach(async () => {
        // Clean up any existing test data first
        await cleanupTestData();

        // Setup test data
        const key = createUserBalanceKey(testUserId);
        const now = new Date().toISOString();

        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                ...key,
                userId: testUserId,
                balance: testBalance,
                version: 1,
                createdAt: now,
                updatedAt: now,
            },
        }));
    });

    afterEach(async () => {
        await cleanupTestData();
    });

    async function cleanupTestData() {
        // Clean up test data
        const scanResult = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(PK, :userPrefix)',
            ExpressionAttributeValues: {
                ':userPrefix': `USER#${testUserId}`,
            },
        }));

        for (const item of scanResult.Items || []) {
            await docClient.send(new DeleteCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: item.PK,
                    SK: item.SK,
                },
            }));
        }
    }

    describe('successful balance retrieval', () => {
        it('should return balance for existing user', async () => {
            const result = await getCurrentBalance(testUserId);

            expect(result).toEqual({
                userId: testUserId,
                balance: testBalance,
            });
        });

        it('should return zero balance for new user', async () => {
            const newUserId = 'new-user-' + Date.now();
            const result = await getCurrentBalance(newUserId);

            expect(result).toEqual({
                userId: newUserId,
                balance: 0,
            });
        });

        it('should handle decimal balances correctly', async () => {
            const decimalUserId = 'decimal-user-' + Date.now();
            const decimalBalance = 123.45;

            const key = createUserBalanceKey(decimalUserId);
            const now = new Date().toISOString();

            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    ...key,
                    userId: decimalUserId,
                    balance: decimalBalance,
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                },
            }));

            const result = await getCurrentBalance(decimalUserId);
            expect(result.balance).toBe(decimalBalance);
        });

        it('should handle large balance amounts', async () => {
            const largeBalanceUserId = 'large-balance-user-' + Date.now();
            const largeBalance = 999999.99;

            const key = createUserBalanceKey(largeBalanceUserId);
            const now = new Date().toISOString();

            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    ...key,
                    userId: largeBalanceUserId,
                    balance: largeBalance,
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                },
            }));

            const result = await getCurrentBalance(largeBalanceUserId);
            expect(result.balance).toBe(largeBalance);
        });
    });

    describe('input validation', () => {
        it('should throw error for empty userId', async () => {
            await expect(getCurrentBalance('')).rejects.toThrow(BalanceError);
            await expect(getCurrentBalance('')).rejects.toThrow('Invalid userId: must be a non-empty string');
        });

        it('should throw error for whitespace-only userId', async () => {
            await expect(getCurrentBalance('   ')).rejects.toThrow(BalanceError);
            await expect(getCurrentBalance('\t')).rejects.toThrow(BalanceError);
            await expect(getCurrentBalance('\n')).rejects.toThrow(BalanceError);
        });

        it('should throw error for null userId', async () => {
            await expect(getCurrentBalance(null as any)).rejects.toThrow(BalanceError);
        });

        it('should throw error for undefined userId', async () => {
            await expect(getCurrentBalance(undefined as any)).rejects.toThrow(BalanceError);
        });

        it('should throw error for non-string userId', async () => {
            await expect(getCurrentBalance(123 as any)).rejects.toThrow(BalanceError);
            await expect(getCurrentBalance({} as any)).rejects.toThrow(BalanceError);
            await expect(getCurrentBalance([] as any)).rejects.toThrow(BalanceError);
        });
    });

    describe('edge cases and error handling', () => {
        it('should handle very long userId', async () => {
            const longUserId = 'user-with-very-long-id-' + 'x'.repeat(1000);
            const result = await getCurrentBalance(longUserId);

            // Should still work even with long userId
            expect(result.userId).toBe(longUserId);
            expect(result.balance).toBe(0);
        });

        it('should handle special characters in userId', async () => {
            const specialUserId = 'user@#$%^&*()_+{}|:<>?[]\\;\'",./`~';
            const result = await getCurrentBalance(specialUserId);

            expect(result.userId).toBe(specialUserId);
            expect(result.balance).toBe(0);
        });

        it('should handle unicode characters in userId', async () => {
            const unicodeUserId = 'user-测试-🚀-привет';
            const result = await getCurrentBalance(unicodeUserId);

            expect(result.userId).toBe(unicodeUserId);
            expect(result.balance).toBe(0);
        });

        it('should handle userId with numbers', async () => {
            const numericUserId = 'user123';
            const result = await getCurrentBalance(numericUserId);

            expect(result.userId).toBe(numericUserId);
            expect(result.balance).toBe(0);
        });

        it('should handle negative balance in database', async () => {
            // This shouldn't happen in production due to our transaction logic,
            // but let's test that we handle it correctly if it does exist
            const negativeBalanceUserId = 'negative-balance-user-' + Date.now();
            const negativeBalance = -100;

            const key = createUserBalanceKey(negativeBalanceUserId);
            const now = new Date().toISOString();

            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    ...key,
                    userId: negativeBalanceUserId,
                    balance: negativeBalance,
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                },
            }));

            const result = await getCurrentBalance(negativeBalanceUserId);
            expect(result.balance).toBe(negativeBalance);
        });

        it('should handle zero balance correctly', async () => {
            const zeroBalanceUserId = 'zero-balance-user-' + Date.now();

            const key = createUserBalanceKey(zeroBalanceUserId);
            const now = new Date().toISOString();

            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    ...key,
                    userId: zeroBalanceUserId,
                    balance: 0,
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                },
            }));

            const result = await getCurrentBalance(zeroBalanceUserId);
            expect(result.balance).toBe(0);
        });
    });

    describe('concurrent access', () => {
        it('should handle multiple concurrent balance requests', async () => {
            const concurrentUserId = 'concurrent-user-' + Date.now();
            const requests = Array.from({ length: 10 }, () => getCurrentBalance(concurrentUserId));

            const results = await Promise.all(requests);

            // All requests should return the same result
            results.forEach(result => {
                expect(result.userId).toBe(concurrentUserId);
                expect(result.balance).toBe(0);
            });
        });
    });
});
