import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// DynamoDB Local configuration
export const dynamoClient = new DynamoDBClient({
    region: 'us-east-1', // Local DynamoDB doesn't enforce regions, but AWS SDK requires it
    endpoint: 'http://localhost:8000',
    credentials: {
        accessKeyId: 'dummy', // Dummy credentials for local DynamoDB
        secretAccessKey: 'dummy',
    },
});

// Document client for easier operations
export const docClient = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: {
        convertEmptyValues: true, // Convert empty strings to null
        removeUndefinedValues: true, // Remove undefined values
        convertClassInstanceToMap: true, // Convert class instances to plain objects
    },
});

// Table configuration
export const TABLE_NAME = 'BalanceTransactions';
export const BALANCE_TTL_DAYS = 30; // TTL for idempotency records

// Key patterns
export const createUserBalanceKey = (userId: string) => ({
    PK: `USER#${userId}`,
    SK: 'BALANCE',
});

export const createTransactionKey = (userId: string, timestamp: string, idempotentKey: string) => ({
    PK: `USER#${userId}`,
    SK: `TXN#${timestamp}#${idempotentKey}`,
});

export const createIdempotencyKey = (idempotentKey: string) => ({
    PK: `TXN#${idempotentKey}`,
    SK: 'RESULT',
});
