import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import app from '../api/routes.js';
import { docClient, TABLE_NAME, createUserBalanceKey } from '../db/config.js';

describe('API Routes', () => {
    const testUserId = 'test-user-api';
    const initialBalance = 1000;

    beforeEach(async () => {
        // Setup test user
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
        // Clean up test data
        try {
            const scanResult = await docClient.send(new ScanCommand({
                TableName: TABLE_NAME,
                FilterExpression: 'begins_with(PK, :userPrefix) OR begins_with(PK, :txnPrefix)',
                ExpressionAttributeValues: {
                    ':userPrefix': `USER#${testUserId}`,
                    ':txnPrefix': 'TXN#test-api-',
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

    describe('GET /health', () => {
        it('should return healthy status', async () => {
            const req = new Request('http://localhost/health', {
                method: 'GET',
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(200);

            const body = await res.json() as { status: string; timestamp: string };
            expect(body.status).toBe('healthy');
            expect(body.timestamp).toBeDefined();
        });
    });

    describe('POST /balance', () => {
        it('should return balance for existing user', async () => {
            const req = new Request('http://localhost/balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: testUserId }),
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(200);

            const body = await res.json() as { success: boolean; data: { userId: string; balance: number } };
            expect(body.success).toBe(true);
            expect(body.data.userId).toBe(testUserId);
            expect(body.data.balance).toBe(initialBalance);
        });

        it('should return zero balance for new user', async () => {
            const newUserId = 'new-api-user-' + Date.now();
            const req = new Request('http://localhost/balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: newUserId }),
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(200);

            const body = await res.json() as { success: boolean; data: { userId: string; balance: number } };
            expect(body.success).toBe(true);
            expect(body.data.userId).toBe(newUserId);
            expect(body.data.balance).toBe(0);
        });

        it('should return error for invalid request', async () => {
            const req = new Request('http://localhost/balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}), // Missing userId
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(400);

            const body = await res.json() as { success: boolean; error: { code: string; message: string } };
            expect(body.success).toBe(false);
            expect(body.error.code).toBe('INVALID_REQUEST');
        });
    });

    describe('POST /transact', () => {
        it('should successfully process a credit transaction', async () => {
            const idempotentKey = 'test-api-credit-' + Date.now();
            const req = new Request('http://localhost/transact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idempotentKey,
                    userId: testUserId,
                    amount: '100',
                    type: 'credit',
                }),
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(200);

            const body = await res.json() as { success: boolean; data: { success: boolean; newBalance: number } };
            expect(body.success).toBe(true);
            expect(body.data.success).toBe(true);
            expect(body.data.newBalance).toBe(initialBalance + 100);
        });

        it('should successfully process a debit transaction', async () => {
            const idempotentKey = 'test-api-debit-' + Date.now();
            const req = new Request('http://localhost/transact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idempotentKey,
                    userId: testUserId,
                    amount: '200',
                    type: 'debit',
                }),
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(200);

            const body = await res.json() as { success: boolean; data: { success: boolean; newBalance: number } };
            expect(body.success).toBe(true);
            expect(body.data.success).toBe(true);
            expect(body.data.newBalance).toBe(initialBalance - 200);
        });

        it('should handle idempotent transactions', async () => {
            const idempotentKey = 'test-api-idempotent-' + Date.now();

            // First request
            const req1 = new Request('http://localhost/transact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idempotentKey,
                    userId: testUserId,
                    amount: '50',
                    type: 'credit',
                }),
            });

            const res1 = await app.fetch(req1);
            expect(res1.status).toBe(200);

            // Second request with same idempotent key
            const req2 = new Request('http://localhost/transact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idempotentKey,
                    userId: testUserId,
                    amount: '50',
                    type: 'credit',
                }),
            });

            const res2 = await app.fetch(req2);
            expect(res2.status).toBe(200);

            const body2 = await res2.json() as { success: boolean; data: { message: string; newBalance: number } };
            expect(body2.success).toBe(true);
            expect(body2.data.message).toContain('idempotent');
            expect(body2.data.newBalance).toBe(initialBalance + 50); // Same balance
        });

        it('should reject insufficient funds', async () => {
            const idempotentKey = 'test-api-insufficient-' + Date.now();
            const req = new Request('http://localhost/transact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idempotentKey,
                    userId: testUserId,
                    amount: '2000', // More than balance
                    type: 'debit',
                }),
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(402); // Payment Required

            const body = await res.json() as { success: boolean; error: { code: string; message: string } };
            expect(body.success).toBe(false);
            expect(body.error.code).toBe('INSUFFICIENT_FUNDS');
        });

        it('should validate required fields', async () => {
            const req = new Request('http://localhost/transact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    // Missing required fields
                    userId: testUserId,
                    amount: '100',
                }),
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(400);

            const body = await res.json() as { success: boolean; error: { code: string; message: string } };
            expect(body.success).toBe(false);
            expect(body.error.code).toBe('INVALID_REQUEST');
        });

        it('should validate transaction type', async () => {
            const req = new Request('http://localhost/transact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idempotentKey: 'test-invalid-type-' + Date.now(),
                    userId: testUserId,
                    amount: '100',
                    type: 'invalid',
                }),
            });

            const res = await app.fetch(req);
            expect(res.status).toBe(400);

            const body = await res.json() as { success: boolean; error: { code: string; message: string } };
            expect(body.success).toBe(false);
            expect(body.error.code).toBe('INVALID_REQUEST');
        });
    });
});
