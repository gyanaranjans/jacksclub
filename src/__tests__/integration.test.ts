import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getCurrentBalance } from '../services/balance.js';
import { transact } from '../services/transaction.js';
import { docClient, TABLE_NAME, createUserBalanceKey } from '../db/config.js';
import type { BalanceError, InsufficientFundsError } from '../types/index.js';

describe('Integration Tests - Full System Flow', () => {
    const testUsers = ['integration-user-1', 'integration-user-2', 'integration-user-3'];
    const initialBalances = {
        'integration-user-1': 1000,
        'integration-user-2': 500,
        'integration-user-3': 0,
    };

    beforeAll(async () => {
        // Setup initial balances for all test users
        console.log('Setting up integration test data...');

        for (const userId of testUsers) {
            const key = createUserBalanceKey(userId);
            const now = new Date().toISOString();

            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    ...key,
                    userId,
                    balance: initialBalances[userId as keyof typeof initialBalances],
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                },
            }));
        }
    });

    afterAll(async () => {
        // Clean up all test data
        console.log('Cleaning up integration test data...');

        for (const userId of testUsers) {
            const scanResult = await docClient.send(new ScanCommand({
                TableName: TABLE_NAME,
                FilterExpression: 'begins_with(PK, :userPrefix) OR begins_with(PK, :txnPrefix)',
                ExpressionAttributeValues: {
                    ':userPrefix': `USER#${userId}`,
                    ':txnPrefix': 'TXN#integration-',
                },
            }));

            for (const item of scanResult.Items || []) {
                await docClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: {
                        ...item,
                        ttl: Math.floor(Date.now() / 1000) + 300, // Expire in 5 minutes
                    },
                }));
            }
        }
    });

    describe('Multi-user balance management', () => {
        it('should handle simultaneous operations across multiple users', async () => {
            const operations = [
                // User 1 operations
                { userId: testUsers[0], amount: '100', type: 'credit' as const, idempotentKey: 'int-multi-1' },
                { userId: testUsers[0], amount: '50', type: 'debit' as const, idempotentKey: 'int-multi-2' },

                // User 2 operations
                { userId: testUsers[1], amount: '200', type: 'credit' as const, idempotentKey: 'int-multi-3' },
                { userId: testUsers[1], amount: '75', type: 'debit' as const, idempotentKey: 'int-multi-4' },

                // User 3 operations (starts with 0)
                { userId: testUsers[2], amount: '300', type: 'credit' as const, idempotentKey: 'int-multi-5' },
                { userId: testUsers[2], amount: '100', type: 'debit' as const, idempotentKey: 'int-multi-6' },
            ];

            // Execute all operations
            const results = await Promise.all(
                operations.map(op =>
                    transact({
                        idempotentKey: `integration-${op.idempotentKey}-${Date.now()}`,
                        userId: op.userId,
                        amount: op.amount,
                        type: op.type,
                    })
                )
            );

            // All operations should succeed
            results.forEach(result => {
                expect(result.success).toBe(true);
            });

            // Verify final balances
            const finalBalances = await Promise.all(
                testUsers.map(userId => getCurrentBalance(userId))
            );

            expect(finalBalances[0].balance).toBe(initialBalances[testUsers[0]] + 100 - 50); // 1000 + 100 - 50 = 1050
            expect(finalBalances[1].balance).toBe(initialBalances[testUsers[1]] + 200 - 75); // 500 + 200 - 75 = 625
            expect(finalBalances[2].balance).toBe(initialBalances[testUsers[2]] + 300 - 100); // 0 + 300 - 100 = 200
        });

        it('should maintain data consistency during concurrent operations', async () => {
            const userId = testUsers[0];
            const initialBalance = await getCurrentBalance(userId);

            // Create 20 concurrent operations
            const concurrentOps = Array.from({ length: 20 }, (_, i) => ({
                idempotentKey: `concurrent-${Date.now()}-${i}`,
                userId,
                amount: '10',
                type: i % 2 === 0 ? 'credit' as const : 'debit' as const,
            }));

            // Execute all operations concurrently
            const results = await Promise.allSettled(
                concurrentOps.map(op => transact(op))
            );

            // Count successful operations
            const successful = results.filter(r =>
                r.status === 'fulfilled' && (r.value as any).success
            ).length;

            const failed = results.filter(r =>
                r.status === 'rejected' ||
                (r.status === 'fulfilled' && !(r.value as any).success)
            ).length;

            expect(successful + failed).toBe(20);

            // Verify final balance is consistent
            const finalBalance = await getCurrentBalance(userId);
            const expectedBalance = initialBalance.balance +
                (concurrentOps.filter(op => op.type === 'credit').length * 10) -
                (concurrentOps.filter(op => op.type === 'debit').length * 10);

            expect(finalBalance.balance).toBe(expectedBalance);
        });
    });

    describe('End-to-end transaction scenarios', () => {
        it('should handle a complete user journey', async () => {
            const userId = 'journey-user-' + Date.now();

            // 1. New user starts with 0 balance
            let balance = await getCurrentBalance(userId);
            expect(balance.balance).toBe(0);

            // 2. User receives initial deposit
            const deposit1 = await transact({
                idempotentKey: `journey-deposit-1-${Date.now()}`,
                userId,
                amount: '1000',
                type: 'credit',
            });
            expect(deposit1.success).toBe(true);
            expect(deposit1.newBalance).toBe(1000);

            // 3. User makes several transactions
            const transactions = [
                { amount: '100', type: 'debit' as const, expectedBalance: 900 },
                { amount: '50', type: 'credit' as const, expectedBalance: 950 },
                { amount: '25', type: 'debit' as const, expectedBalance: 925 },
                { amount: '200', type: 'credit' as const, expectedBalance: 1125 },
            ];

            for (let i = 0; i < transactions.length; i++) {
                const tx = transactions[i];
                const result = await transact({
                    idempotentKey: `journey-tx-${i}-${Date.now()}`,
                    userId,
                    amount: tx.amount,
                    type: tx.type,
                });

                expect(result.success).toBe(true);
                expect(result.newBalance).toBe(tx.expectedBalance);
            }

            // 4. Verify final balance
            const finalBalance = await getCurrentBalance(userId);
            expect(finalBalance.balance).toBe(1125);

            // 5. Test idempotency by repeating a transaction
            const repeatTx = await transact({
                idempotentKey: `journey-tx-0-${Date.now()}`, // Same idempotent key as first transaction
                userId,
                amount: '100',
                type: 'debit',
            });

            expect(repeatTx.success).toBe(true);
            expect(repeatTx.message).toContain('idempotent');
            expect(repeatTx.newBalance).toBe(1125); // Balance unchanged
        });

        it('should handle business workflow: purchase with insufficient funds', async () => {
            const customerId = 'customer-' + Date.now();
            const merchantId = 'merchant-' + Date.now();

            // Setup customer with limited balance
            await transact({
                idempotentKey: `setup-customer-${Date.now()}`,
                userId: customerId,
                amount: '100',
                type: 'credit',
            });

            // Setup merchant with zero balance
            const merchantBalance = await getCurrentBalance(merchantId);
            expect(merchantBalance.balance).toBe(0);

            // Customer tries to purchase expensive item
            try {
                await transact({
                    idempotentKey: `purchase-fail-${Date.now()}`,
                    userId: customerId,
                    amount: '200', // More than customer's balance
                    type: 'debit',
                });
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(InsufficientFundsError);
            }

            // Customer's balance should remain unchanged
            const customerBalanceAfter = await getCurrentBalance(customerId);
            expect(customerBalanceAfter.balance).toBe(100);

            // Merchant should still have zero balance
            const merchantBalanceAfter = await getCurrentBalance(merchantId);
            expect(merchantBalanceAfter.balance).toBe(0);

            // Successful smaller purchase
            const purchaseResult = await transact({
                idempotentKey: `purchase-success-${Date.now()}`,
                userId: customerId,
                amount: '50',
                type: 'debit',
            });

            expect(purchaseResult.success).toBe(true);
            expect(purchaseResult.newBalance).toBe(50);

            // Simulate payment to merchant
            const paymentResult = await transact({
                idempotentKey: `merchant-payment-${Date.now()}`,
                userId: merchantId,
                amount: '50',
                type: 'credit',
            });

            expect(paymentResult.success).toBe(true);
            expect(paymentResult.newBalance).toBe(50);
        });
    });

    describe('System resilience and edge cases', () => {
        it('should handle rapid successive transactions', async () => {
            const userId = 'rapid-user-' + Date.now();

            // Start with some balance
            await transact({
                idempotentKey: `rapid-setup-${Date.now()}`,
                userId,
                amount: '1000',
                type: 'credit',
            });

            const startTime = Date.now();

            // Perform 50 rapid transactions
            const rapidTransactions = Array.from({ length: 50 }, (_, i) => ({
                idempotentKey: `rapid-${i}-${Date.now()}`,
                userId,
                amount: '10',
                type: i % 3 === 0 ? 'debit' as const : 'credit' as const, // Mostly credits
            }));

            const results = await Promise.all(
                rapidTransactions.map(tx => transact(tx))
            );

            const endTime = Date.now();
            const duration = endTime - startTime;

            // All should succeed
            results.forEach(result => {
                expect(result.success).toBe(true);
            });

            // Should complete in reasonable time
            expect(duration).toBeLessThan(30000); // 30 seconds

            // Final balance should be correct
            const finalBalance = await getCurrentBalance(userId);
            const expectedCredits = rapidTransactions.filter(tx => tx.type === 'credit').length * 10;
            const expectedDebits = rapidTransactions.filter(tx => tx.type === 'debit').length * 10;
            const expectedBalance = 1000 + expectedCredits - expectedDebits;

            expect(finalBalance.balance).toBe(expectedBalance);
        });

        it('should handle large numbers of idempotent requests', async () => {
            const userId = 'idempotent-user-' + Date.now();
            const idempotentKey = `bulk-idempotent-${Date.now()}`;

            // Setup initial balance
            await transact({
                idempotentKey: `bulk-setup-${Date.now()}`,
                userId,
                amount: '100',
                type: 'credit',
            });

            // Make 100 identical requests with the same idempotent key
            const promises = Array.from({ length: 100 }, () =>
                transact({
                    idempotentKey,
                    userId,
                    amount: '25',
                    type: 'credit',
                })
            );

            const results = await Promise.all(promises);

            // All should succeed with the same result
            results.forEach((result, index) => {
                expect(result.success).toBe(true);
                expect(result.newBalance).toBe(125); // 100 + 25
                if (index > 0) {
                    expect(result.message).toContain('idempotent');
                }
            });

            // Balance should only be affected once
            const finalBalance = await getCurrentBalance(userId);
            expect(finalBalance.balance).toBe(125);
        });

        it('should maintain consistency under failure conditions', async () => {
            const userId = 'failure-user-' + Date.now();

            // Setup balance
            await transact({
                idempotentKey: `failure-setup-${Date.now()}`,
                userId,
                amount: '500',
                type: 'credit',
            });

            const initialBalance = await getCurrentBalance(userId);
            expect(initialBalance.balance).toBe(500);

            // Mix of successful and failed transactions
            const mixedOperations = [
                { amount: '100', type: 'debit' as const, shouldSucceed: true },
                { amount: '600', type: 'debit' as const, shouldSucceed: false }, // Insufficient funds
                { amount: '50', type: 'debit' as const, shouldSucceed: true },
                { amount: '1000', type: 'debit' as const, shouldSucceed: false }, // Insufficient funds
                { amount: '25', type: 'credit' as const, shouldSucceed: true },
            ];

            for (const op of mixedOperations) {
                try {
                    const result = await transact({
                        idempotentKey: `failure-${Date.now()}-${Math.random()}`,
                        userId,
                        amount: op.amount,
                        type: op.type,
                    });

                    if (op.shouldSucceed) {
                        expect(result.success).toBe(true);
                    } else {
                        expect(true).toBe(false); // Should have thrown
                    }
                } catch (error) {
                    if (!op.shouldSucceed) {
                        expect(error).toBeInstanceOf(InsufficientFundsError);
                    } else {
                        throw error; // Unexpected failure
                    }
                }
            }

            // Final balance should be consistent: 500 - 100 - 50 + 25 = 375
            const finalBalance = await getCurrentBalance(userId);
            expect(finalBalance.balance).toBe(375);
        });
    });

    describe('Cross-system validation', () => {
        it('should validate balance calculations across multiple services', async () => {
            const userId = 'validation-user-' + Date.now();

            // Perform a series of operations and track expected balance
            let expectedBalance = 0;

            const operations = [
                { amount: '1000', type: 'credit' as const },
                { amount: '100', type: 'debit' as const },
                { amount: '50', type: 'debit' as const },
                { amount: '200', type: 'credit' as const },
                { amount: '75', type: 'debit' as const },
                { amount: '25', type: 'credit' as const },
            ];

            for (let i = 0; i < operations.length; i++) {
                const op = operations[i];
                const result = await transact({
                    idempotentKey: `validation-${i}-${Date.now()}`,
                    userId,
                    amount: op.amount,
                    type: op.type,
                });

                expectedBalance += (op.type === 'credit' ? 1 : -1) * parseFloat(op.amount);

                expect(result.success).toBe(true);
                expect(result.newBalance).toBe(expectedBalance);

                // Cross-validate with getCurrentBalance
                const balanceCheck = await getCurrentBalance(userId);
                expect(balanceCheck.balance).toBe(expectedBalance);
            }

            // Final validation
            const finalBalance = await getCurrentBalance(userId);
            expect(finalBalance.balance).toBe(expectedBalance);
        });

        it('should handle timezone and timestamp consistency', async () => {
            const userId = 'timezone-user-' + Date.now();

            // Perform operations at different "times" (simulated)
            const operations = [
                { amount: '100', type: 'credit' as const, delay: 0 },
                { amount: '25', type: 'debit' as const, delay: 100 },
                { amount: '50', type: 'credit' as const, delay: 200 },
            ];

            const results = [];

            for (const op of operations) {
                if (op.delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, op.delay));
                }

                const result = await transact({
                    idempotentKey: `timezone-${Date.now()}-${Math.random()}`,
                    userId,
                    amount: op.amount,
                    type: op.type,
                });

                results.push(result);
                expect(result.success).toBe(true);
            }

            // Verify timestamps are in correct order
            for (let i = 1; i < results.length; i++) {
                expect(new Date(results[i].timestamp || 0) >= new Date(results[i - 1].timestamp || 0)).toBe(true);
            }

            // Final balance should be correct: 100 - 25 + 50 = 125
            const finalBalance = await getCurrentBalance(userId);
            expect(finalBalance.balance).toBe(125);
        });
    });
});
