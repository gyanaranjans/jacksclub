import { Hono } from 'hono';
import { getCurrentBalance } from '../services/balance.js';
import { transact } from '../services/transaction.js';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GetBalanceRequest, TransactRequest } from '../types/index.js';
import { BalanceError, InsufficientFundsError } from '../types/index.js';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

// DynamoDB client for data inspection
const dynamoClient = new DynamoDBClient({
    region: 'us-east-1',
    endpoint: 'http://localhost:8000',
    credentials: {
        accessKeyId: 'dummy',
        secretAccessKey: 'dummy',
    },
});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

const app = new Hono();

// Error handler for Hono
app.onError((error, c) => {
    // Handle our custom errors first
    if (error instanceof InsufficientFundsError) {
        return c.json({
            success: false,
            error: {
                code: error.code,
                message: error.message,
            },
        }, 402); // Payment Required
    } else if (error instanceof BalanceError) {
        const statusCode = getStatusCodeForError(error.code);
        return c.json({
            success: false,
            error: {
                code: error.code,
                message: error.message,
            },
        }, statusCode);
    }

    // Handle AWS DynamoDB errors that might wrap our custom errors
    if (error instanceof ConditionalCheckFailedException) {
        // This usually means insufficient funds or race condition
        return c.json({
            success: false,
            error: {
                code: 'INSUFFICIENT_FUNDS',
                message: 'Transaction failed due to insufficient funds or concurrent modification',
            },
        }, 402);
    }

    // Handle generic AWS errors
    if (error && typeof error === 'object' && '$metadata' in error) {
        const awsError = error as any;
        if (awsError.name === 'TransactionCanceledException') {
            return c.json({
                success: false,
                error: {
                    code: 'RACE_CONDITION',
                    message: 'Transaction cancelled due to concurrent modification. Please retry.',
                },
            }, 409);
        }
    }

    // Log unexpected errors for debugging
    console.error('Unexpected API error:', error);
    return c.json({
        success: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
        },
    }, 500);
});

// GET /health - Health check endpoint
app.get('/health', (c) => {
    return c.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// POST /balance - Get current balance
app.post('/balance', async (c) => {
    const body = await c.req.json<GetBalanceRequest>();

    // Validate input
    if (!body.userId || typeof body.userId !== 'string') {
        return c.json({
            success: false,
            error: {
                code: 'INVALID_REQUEST',
                message: 'userId is required and must be a string',
            },
        }, 400);
    }

    const result = await getCurrentBalance(body.userId);

    return c.json({
        success: true,
        data: result,
    });
});

// POST /transact - Process a transaction
app.post('/transact', async (c) => {
    const body = await c.req.json<TransactRequest>();

    // Validate input
    const requiredFields = ['idempotentKey', 'userId', 'amount', 'type'];
    const missingFields = requiredFields.filter(field => !body[field as keyof TransactRequest]);

    if (missingFields.length > 0) {
        return c.json({
            success: false,
            error: {
                code: 'INVALID_REQUEST',
                message: `Missing required fields: ${missingFields.join(', ')}`,
            },
        }, 400);
    }

    if (!['credit', 'debit'].includes(body.type)) {
        return c.json({
            success: false,
            error: {
                code: 'INVALID_REQUEST',
                message: 'type must be either "credit" or "debit"',
            },
        }, 400);
    }

    if (typeof body.amount !== 'string') {
        return c.json({
            success: false,
            error: {
                code: 'INVALID_REQUEST',
                message: 'amount must be a string representation of a number',
            },
        }, 400);
    }

    const result = await transact(body);

    return c.json({
        success: true,
        data: result,
    });
});

// GET / - Serve the database viewer UI
app.get('/', async (c) => {
    try {
        const html = await Bun.file('db-viewer.html').text();
        return c.html(html);
    } catch (error) {
        return c.text('Database viewer not found. Make sure db-viewer.html exists.', 404);
    }
});

// GET /api/db-data - Get all database data for the UI
app.get('/api/db-data', async (c) => {
    try {
        const scanCommand = new ScanCommand({
            TableName: 'BalanceTransactions',
        });

        const response = await dynamoClient.send(scanCommand);

        if (!response.Items || response.Items.length === 0) {
            return c.json({
                balances: [],
                transactions: [],
                idempotency: []
            });
        }

        // Convert DynamoDB items to plain objects
        const plainItems = response.Items.map(item => {
            const plain: any = {};
            for (const [key, value] of Object.entries(item)) {
                if (value.S) plain[key] = value.S; // String
                else if (value.N) plain[key] = parseFloat(value.N); // Number
                else if (value.BOOL !== undefined) plain[key] = value.BOOL; // Boolean
                else plain[key] = value; // Other types
            }
            return plain;
        });

        // Group items by type
        const balances: any[] = [];
        const transactions: any[] = [];
        const idempotencyRecords: any[] = [];

        for (const item of plainItems) {
            if (item.SK === 'BALANCE') {
                balances.push({
                    userId: item.userId,
                    balance: item.balance || 0,
                    version: item.version || 1,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt
                });
            } else if (item.SK && typeof item.SK === 'string' && item.SK.startsWith('TXN#') && !item.SK.includes('#RESULT')) {
                transactions.push({
                    userId: item.userId,
                    type: item.type,
                    amount: item.amount || 0,
                    balanceAfter: item.balanceAfter || 0,
                    status: item.status,
                    idempotentKey: item.idempotentKey,
                    timestamp: item.timestamp
                });
            } else if (item.SK === 'RESULT') {
                idempotencyRecords.push({
                    idempotentKey: item.idempotentKey,
                    userId: item.userId,
                    type: item.type,
                    amount: item.amount || 0,
                    newBalance: item.newBalance || 0,
                    status: item.status,
                    timestamp: item.timestamp,
                    ttl: item.ttl
                });
            }
        }

        // Sort data
        balances.sort((a, b) => (a.userId || '').localeCompare(b.userId || ''));
        transactions.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
        idempotencyRecords.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

        return c.json({
            balances,
            transactions,
            idempotency: idempotencyRecords
        });

    } catch (error) {
        console.error('Error fetching database data:', error);
        return c.json({
            error: 'Failed to fetch database data',
            details: error.message
        }, 500);
    }
});

// Helper function to map error codes to HTTP status codes
function getStatusCodeForError(code: string): number {
    switch (code) {
        case 'INVALID_USER_ID':
        case 'INVALID_IDEMPOTENT_KEY':
        case 'INVALID_AMOUNT':
        case 'INVALID_AMOUNT_FORMAT':
        case 'INVALID_TRANSACTION_TYPE':
            return 400;
        case 'INSUFFICIENT_FUNDS':
            return 402; // Payment Required
        case 'DUPLICATE_TRANSACTION':
            return 409; // Conflict
        case 'RACE_CONDITION':
            return 409; // Conflict
        case 'DATABASE_ERROR':
        case 'TRANSACTION_ERROR':
            return 500;
        default:
            return 500;
    }
}

export default app;
