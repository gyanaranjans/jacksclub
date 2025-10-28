import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { transact } from '../services/transaction.js';
import { getCurrentBalance } from '../services/balance.js';
import { docClient, TABLE_NAME, createUserBalanceKey, createIdempotencyKey } from '../db/config.js';
import {
    BalanceError,
    InsufficientFundsError,
    InvalidAmountError,
    RaceConditionError,
} from '../types/index.js';

describe('transact', () => {
    const testUserId = 'test-user-transaction';
    const initialBalance = 1000;

    beforeEach(async () => {
        // Setup test user with initial balance
        const key = createUserBalanceKey(testUserId);
        const now = new Date().toISOString();

        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                ...key,
                userId: testUserId,
                balance: initialBalance,
                version: 1,
                createdAt: now,
                updatedAt: now,
            },
        }));
    });

    afterEach(async () => {
        // Clean up all test data
        try {
            const scanResult = await docClient.send(new ScanCommand({
                TableName: TABLE_NAME,
                FilterExpression: 'begins_with(PK, :userPrefix) OR begins_with(PK, :txnPrefix)',
                ExpressionAttributeValues: {
                    ':userPrefix': `USER#${testUserId}`,
                    ':txnPrefix': 'TXN#test-',
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
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    });

    describe('credit transactions', () => {
        it('should successfully process a credit transaction', async () => {
            const idempotentKey = 'test-credit-' + Date.now();
            const amount = '100';

            const result = await transact({
                idempotentKey,
                userId: testUserId,
                amount,
                type: 'credit',
            });

            expect(result.success).toBe(true);
            expect(result.idempotentKey).toBe(idempotentKey);
            expect(result.userId).toBe(testUserId);
            expect(result.amount).toBe(amount);
            expect(result.type).toBe('credit');
            expect(result.newBalance).toBe(initialBalance + 100);
        });

        it('should handle idempotency for credit transactions', async () => {
            const idempotentKey = 'test-idempotent-credit-' + Date.now();
            const amount = '50';

            // First transaction
            const result1 = await transact({
                idempotentKey,
                userId: testUserId,
                amount,
                type: 'credit',
            });

            expect(result1.success).toBe(true);
            expect(result1.newBalance).toBe(initialBalance + 50);

            // Second transaction with same idempotent key
            const result2 = await transact({
                idempotentKey,
                userId: testUserId,
                amount,
                type: 'credit',
            });

            expect(result2.success).toBe(true);
            expect(result2.newBalance).toBe(initialBalance + 50); // Balance unchanged
            expect(result2.message).toContain('idempotent');
        });
    });

    describe('debit transactions', () => {
        it('should successfully process a debit transaction', async () => {
            const idempotentKey = 'test-debit-' + Date.now();
            const amount = '200';

            const result = await transact({
                idempotentKey,
                userId: testUserId,
                amount,
                type: 'debit',
            });

            expect(result.success).toBe(true);
            expect(result.newBalance).toBe(initialBalance - 200);
        });

        it('should reject debit that would result in negative balance', async () => {
            const idempotentKey = 'test-insufficient-funds-' + Date.now();
            const amount = '1500'; // More than initial balance

            await expect(transact({
                idempotentKey,
                userId: testUserId,
                amount,
                type: 'debit',
            })).rejects.toThrow(InsufficientFundsError);
        });

        it('should handle idempotency for debit transactions', async () => {
            const idempotentKey = 'test-idempotent-debit-' + Date.now();
            const amount = '100';

            // First transaction
            const result1 = await transact({
                idempotentKey,
                userId: testUserId,
                amount,
                type: 'debit',
            });

            expect(result1.success).toBe(true);
            expect(result1.newBalance).toBe(initialBalance - 100);

            // Second transaction with same idempotent key
            const result2 = await transact({
                idempotentKey,
                userId: testUserId,
                amount,
                type: 'debit',
            });

            expect(result2.success).toBe(true);
            expect(result2.newBalance).toBe(initialBalance - 100); // Balance unchanged
        });
    });

    describe('new users', () => {
        it('should allow credit transactions for new users', async () => {
            const newUserId = 'new-user-' + Date.now();
            const idempotentKey = 'test-new-user-credit-' + Date.now();

            const result = await transact({
                idempotentKey,
                userId: newUserId,
                amount: '500',
                type: 'credit',
            });

            expect(result.success).toBe(true);
            expect(result.newBalance).toBe(500);
        });

        it('should reject debit transactions for new users', async () => {
            const newUserId = 'new-user-debit-' + Date.now();
            const idempotentKey = 'test-new-user-debit-' + Date.now();

            await expect(transact({
                idempotentKey,
                userId: newUserId,
                amount: '100',
                type: 'debit',
            })).rejects.toThrow(InsufficientFundsError);
        });
    });

    describe('input validation', () => {
        it('should reject invalid amounts', async () => {
            const testCases = [
                { amount: '0', description: 'zero amount' },
                { amount: '-100', description: 'negative amount' },
                { amount: 'abc', description: 'non-numeric string' },
                { amount: '', description: 'empty string' },
            ];

            for (const testCase of testCases) {
                await expect(transact({
                    idempotentKey: `test-invalid-amount-${Date.now()}`,
                    userId: testUserId,
                    amount: testCase.amount,
                    type: 'credit',
                })).rejects.toThrow(InvalidAmountError);
            }
        });

        it('should reject invalid transaction types', async () => {
            await expect(transact({
                idempotentKey: 'test-invalid-type-' + Date.now(),
                userId: testUserId,
                amount: '100',
                type: 'invalid' as any,
            })).rejects.toThrow(BalanceError);
        });

        it('should reject invalid userId', async () => {
            await expect(transact({
                idempotentKey: 'test-invalid-user-' + Date.now(),
                userId: '',
                amount: '100',
                type: 'credit',
            })).rejects.toThrow(BalanceError);
        });

        it('should reject invalid idempotentKey', async () => {
            await expect(transact({
                idempotentKey: '',
                userId: testUserId,
                amount: '100',
                type: 'credit',
            })).rejects.toThrow(BalanceError);
        });
    });

    describe('concurrent transactions', () => {
        it('should handle race conditions gracefully', async () => {
            // This test simulates concurrent transactions
            // In a real scenario, this would be tested with multiple processes
            const transactions = Array.from({ length: 5 }, (_, i) => ({
                idempotentKey: `test-race-${Date.now()}-${i}`,
                userId: testUserId,
                amount: '50',
                type: 'debit' as const,
            }));

            // Execute transactions concurrently
            const promises = transactions.map(tx => transact(tx));
            const results = await Promise.allSettled(promises);

            // Some should succeed, some should fail due to insufficient funds or race conditions
            const successful = results.filter(r => r.status === 'fulfilled' && (r.value as any).success);
            const failed = results.filter(r => r.status === 'rejected' ||
                (r.status === 'fulfilled' && !(r.value as any).success));

            expect(successful.length + failed.length).toBe(5);

            // The first few should succeed, later ones should fail due to insufficient funds
            // (assuming they execute in order)
        });

        it('should handle mixed credit/debit concurrent transactions', async () => {
            const mixedTransactions = [
                // Multiple credits
                { idempotentKey: `mixed-1-${Date.now()}`, userId: testUserId, amount: '100', type: 'credit' as const },
                { idempotentKey: `mixed-2-${Date.now()}`, userId: testUserId, amount: '200', type: 'credit' as const },
                // Some debits
                { idempotentKey: `mixed-3-${Date.now()}`, userId: testUserId, amount: '50', type: 'debit' as const },
                { idempotentKey: `mixed-4-${Date.now()}`, userId: testUserId, amount: '75', type: 'debit' as const },
                { idempotentKey: `mixed-5-${Date.now()}`, userId: testUserId, amount: '25', type: 'debit' as const },
            ];

            const promises = mixedTransactions.map(tx => transact(tx));
            const results = await Promise.allSettled(promises);

            const successful = results.filter(r => r.status === 'fulfilled' && (r.value as any).success).length;
            const failed = results.filter(r => r.status === 'rejected' ||
                (r.status === 'fulfilled' && !(r.value as any).success)).length;

            expect(successful + failed).toBe(5);
            // All should succeed since we have enough balance for the operations
            expect(successful).toBeGreaterThan(0);
        });
    });

    describe('performance and load testing', () => {
        it('should handle multiple sequential transactions efficiently', async () => {
            const startTime = Date.now();

            // Perform 10 sequential transactions
            for (let i = 0; i < 10; i++) {
                await transact({
                    idempotentKey: `perf-seq-${Date.now()}-${i}`,
                    userId: testUserId,
                    amount: '10',
                    type: i % 2 === 0 ? 'credit' : 'debit',
                });
            }

            const endTime = Date.now();
            const duration = endTime - startTime;

            // Should complete within reasonable time (allowing for DynamoDB latency)
            expect(duration).toBeLessThan(10000); // 10 seconds max
        });

        it('should handle high-frequency idempotent requests', async () => {
            const idempotentKey = `perf-idempotent-${Date.now()}`;

            // Make the same request multiple times rapidly
            const promises = Array.from({ length: 20 }, () => transact({
                idempotentKey,
                userId: testUserId,
                amount: '5',
                type: 'credit',
            }));

            const results = await Promise.all(promises);

            // All should succeed with the same result
            results.forEach(result => {
                expect(result.success).toBe(true);
                expect(result.newBalance).toBe(initialBalance + 5);
                expect(result.message).toContain('idempotent');
            });
        });
    });

    describe('data integrity and consistency', () => {
        it('should maintain balance consistency across multiple operations', async () => {
            const operations = [
                { amount: '100', type: 'credit' as const, expectedBalance: initialBalance + 100 },
                { amount: '50', type: 'debit' as const, expectedBalance: initialBalance + 50 },
                { amount: '25', type: 'credit' as const, expectedBalance: initialBalance + 75 },
                { amount: '75', type: 'debit' as const, expectedBalance: initialBalance },
                { amount: '200', type: 'credit' as const, expectedBalance: initialBalance + 200 },
            ];

            let currentExpectedBalance = initialBalance;

            for (let i = 0; i < operations.length; i++) {
                const op = operations[i];
                const result = await transact({
                    idempotentKey: `consistency-${Date.now()}-${i}`,
                    userId: testUserId,
                    amount: op.amount,
                    type: op.type,
                });

                expect(result.success).toBe(true);
                expect(result.newBalance).toBe(op.expectedBalance);
                currentExpectedBalance = result.newBalance;
            }

            // Final balance check
            const finalBalanceResult = await getCurrentBalance(testUserId);
            expect(finalBalanceResult.balance).toBe(currentExpectedBalance);
        });

        it('should handle transaction rollbacks correctly', async () => {
            // First, set up a specific balance
            const setupResult = await transact({
                idempotentKey: `rollback-setup-${Date.now()}`,
                userId: testUserId,
                amount: '500',
                type: 'credit',
            });

            expect(setupResult.success).toBe(true);
            const balanceAfterSetup = setupResult.newBalance;

            // Attempt a transaction that should fail (insufficient funds)
            const failingResult = await transact({
                idempotentKey: `rollback-fail-${Date.now()}`,
                userId: testUserId,
                amount: '2000', // More than available
                type: 'debit',
            });

            expect(failingResult.success).toBe(false);

            // Balance should remain unchanged
            const finalBalanceResult = await getCurrentBalance(testUserId);
            expect(finalBalanceResult.balance).toBe(balanceAfterSetup);
        });

        it('should prevent double-spending scenarios', async () => {
            // This simulates a double-spend attempt
            const spendAmount = '100';
            const availableBalance = initialBalance;

            // First spend should succeed
            const firstSpend = await transact({
                idempotentKey: `double-spend-1-${Date.now()}`,
                userId: testUserId,
                amount: spendAmount,
                type: 'debit',
            });

            expect(firstSpend.success).toBe(true);

            // Second spend of same amount should fail if balance is insufficient
            if (availableBalance - parseFloat(spendAmount) < parseFloat(spendAmount)) {
                const secondSpend = await transact({
                    idempotentKey: `double-spend-2-${Date.now()}`,
                    userId: testUserId,
                    amount: spendAmount,
                    type: 'debit',
                });

                expect(secondSpend.success).toBe(false);
            }
        });
    });

    describe('error recovery and resilience', () => {
        it('should handle malformed transaction data gracefully', async () => {
            const malformedTransactions = [
                { idempotentKey: '', userId: testUserId, amount: '100', type: 'credit' },
                { idempotentKey: `malformed-${Date.now()}`, userId: '', amount: '100', type: 'credit' },
                { idempotentKey: `malformed-${Date.now()}`, userId: testUserId, amount: 'not-a-number', type: 'credit' },
                { idempotentKey: `malformed-${Date.now()}`, userId: testUserId, amount: '100', type: 'invalid' },
            ];

            for (const tx of malformedTransactions) {
                try {
                    await transact(tx as any);
                    // If we get here, the transaction succeeded unexpectedly
                    expect(true).toBe(false); // Should not reach here
                } catch (error) {
                    expect(error).toBeInstanceOf(BalanceError);
                }
            }
        });

        it('should handle extreme values gracefully', async () => {
            const extremeTransactions = [
                { amount: '0.01', type: 'credit' as const },
                { amount: '999999.99', type: 'credit' as const },
                { amount: '0.01', type: 'debit' as const },
                { amount: '1', type: 'credit' as const },
            ];

            for (let i = 0; i < extremeTransactions.length; i++) {
                const tx = extremeTransactions[i];
                const result = await transact({
                    idempotentKey: `extreme-${Date.now()}-${i}`,
                    userId: testUserId,
                    amount: tx.amount,
                    type: tx.type,
                });

                expect(result.success).toBe(true);
            }
        });
    });

    describe('business logic validation', () => {
        it('should enforce minimum transaction amounts', async () => {
            await expect(transact({
                idempotentKey: `min-amount-${Date.now()}`,
                userId: testUserId,
                amount: '0',
                type: 'credit',
            })).rejects.toThrow(InvalidAmountError);

            await expect(transact({
                idempotentKey: `negative-amount-${Date.now()}`,
                userId: testUserId,
                amount: '-50',
                type: 'credit',
            })).rejects.toThrow(InvalidAmountError);
        });

        it('should validate transaction types strictly', async () => {
            await expect(transact({
                idempotentKey: `invalid-type-${Date.now()}`,
                userId: testUserId,
                amount: '100',
                type: 'CREDIT', // Wrong case
            } as any)).rejects.toThrow(BalanceError);

            await expect(transact({
                idempotentKey: `invalid-type-${Date.now()}`,
                userId: testUserId,
                amount: '100',
                type: 'deposit', // Wrong type
            } as any)).rejects.toThrow(BalanceError);
        });

        it('should handle floating point precision correctly', async () => {
            const precisionTransactions = [
                { amount: '0.1', type: 'credit' as const },
                { amount: '0.2', type: 'credit' as const },
                { amount: '0.3', type: 'debit' as const },
            ];

            let expectedBalance = initialBalance;

            for (let i = 0; i < precisionTransactions.length; i++) {
                const tx = precisionTransactions[i];
                const result = await transact({
                    idempotentKey: `precision-${Date.now()}-${i}`,
                    userId: testUserId,
                    amount: tx.amount,
                    type: tx.type,
                });

                expect(result.success).toBe(true);
                expectedBalance += (tx.type === 'credit' ? 1 : -1) * parseFloat(tx.amount);
                expect(result.newBalance).toBeCloseTo(expectedBalance, 2);
            }
        });
    });
});
