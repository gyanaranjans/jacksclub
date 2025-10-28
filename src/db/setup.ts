import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamoClient, docClient, TABLE_NAME, createUserBalanceKey, BALANCE_TTL_DAYS } from './config.js';

async function createTable() {
    try {
        // Check if table exists
        try {
            await dynamoClient.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
            console.log('Table already exists, skipping creation');
            return;
        } catch (error: any) {
            if (error.name !== 'ResourceNotFoundException') {
                throw error;
            }
        }

        // Create table
        const createTableCommand = new CreateTableCommand({
            TableName: TABLE_NAME,
            KeySchema: [
                { AttributeName: 'PK', KeyType: 'HASH' },
                { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
            AttributeDefinitions: [
                { AttributeName: 'PK', AttributeType: 'S' },
                { AttributeName: 'SK', AttributeType: 'S' },
            ],
            BillingMode: 'PAY_PER_REQUEST', // Use on-demand for local development
            StreamSpecification: {
                StreamEnabled: false,
            },
        });

        await dynamoClient.send(createTableCommand);
        console.log(`Table '${TABLE_NAME}' created successfully`);

        // Wait for table to be active
        console.log('Waiting for table to be active...');
        let isActive = false;
        let attempts = 0;
        const maxAttempts = 30;

        while (!isActive && attempts < maxAttempts) {
            try {
                const describeResponse = await dynamoClient.send(
                    new DescribeTableCommand({ TableName: TABLE_NAME })
                );
                if (describeResponse.Table?.TableStatus === 'ACTIVE') {
                    isActive = true;
                    break;
                }
            } catch (error) {
                console.log('Table not ready yet, waiting...');
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (!isActive) {
            throw new Error('Table creation timed out');
        }

        console.log('Table is now active');
    } catch (error) {
        console.error('Error creating table:', error);
        throw error;
    }
}

async function seedData() {
    const seedUsers = [
        { userId: 'user1', balance: 1000 },
        { userId: 'user2', balance: 500 },
        { userId: 'user3', balance: 0 }, // New user with zero balance
        { userId: 'user4', balance: 2500 },
    ];

    console.log('Seeding initial balance data...');

    for (const user of seedUsers) {
        const key = createUserBalanceKey(user.userId);
        const now = new Date().toISOString();

        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                ...key,
                userId: user.userId,
                balance: user.balance,
                version: 1,
                createdAt: now,
                updatedAt: now,
            },
        }));

        console.log(`Seeded balance for ${user.userId}: $${user.balance}`);
    }

    console.log('Seed data created successfully');
}

async function deleteTable() {
    try {
        await dynamoClient.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
        console.log(`Table '${TABLE_NAME}' deleted successfully`);
    } catch (error: any) {
        if (error.name === 'ResourceNotFoundException') {
            console.log('Table does not exist, skipping deletion');
        } else {
            console.error('Error deleting table:', error);
            throw error;
        }
    }
}

async function main() {
    const command = process.argv[2];

    switch (command) {
        case 'create':
            await createTable();
            await seedData();
            break;
        case 'delete':
            await deleteTable();
            break;
        case 'recreate':
            await deleteTable();
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for deletion
            await createTable();
            await seedData();
            break;
        default:
            console.log('Usage: bun run setup.ts <create|delete|recreate>');
            console.log('  create  - Create table and seed data');
            console.log('  delete  - Delete table');
            console.log('  recreate - Delete and recreate table with seed data');
            process.exit(1);
    }
}

if (import.meta.main) {
    main().catch(console.error);
}
