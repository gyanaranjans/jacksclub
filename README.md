# JacksClub - DynamoDB Balance and Transaction System

A robust balance management system built with TypeScript, DynamoDB Local, and Hono framework. This system provides idempotent transaction processing with race condition handling and comprehensive testing.

## Features

- ✅ **Idempotent Transactions**: Prevent duplicate transactions using idempotency keys
- ✅ **Race Condition Handling**: Atomic operations using DynamoDB transactions
- ✅ **Balance Validation**: Prevent negative balances with conditional writes
- ✅ **TypeScript**: Full type safety throughout the application
- ✅ **Comprehensive Testing**: Unit and integration tests with Bun test runner
- ✅ **REST API**: Clean API endpoints with error handling

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Database**: DynamoDB Local (with AWS SDK)
- **Web Framework**: Hono
- **Testing**: Bun test runner

## Prerequisites

- [Bun](https://bun.sh/) installed
- [Docker](https://docker.com/) for DynamoDB Local (optional, can use AWS DynamoDB)
- Node.js (if running with npm instead of bun)

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Start DynamoDB Local

```bash
# Using Docker Compose (recommended)
docker-compose up -d

# Or manually with Docker
docker run -p 8000:8000 amazon/dynamodb-local

# Or install DynamoDB Local directly and run:
# java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -sharedDb -inMemory
```

### 3. Setup Database

```bash
# Create table and seed initial data
bun run setup-db create

# Or recreate table (drops existing data)
bun run setup-db recreate
```

### 4. Start the Server

```bash
bun run dev
```

The server will start on `http://localhost:3000`

## API Endpoints

### Health Check
```http
GET /health
```

### Get Balance
```http
POST /balance
Content-Type: application/json

{
  "userId": "user123"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "userId": "user123",
    "balance": 1000
  }
}
```

### Process Transaction
```http
POST /transact
Content-Type: application/json

{
  "idempotentKey": "txn-123456",
  "userId": "user123",
  "amount": "100.50",
  "type": "credit"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "success": true,
    "idempotentKey": "txn-123456",
    "userId": "user123",
    "amount": "100.50",
    "type": "credit",
    "newBalance": 1100.50,
    "message": "Transaction completed successfully"
  }
}
```

## Testing

### Run All Tests

```bash
bun test
```

### Run Specific Test Files

```bash
bun test src/__tests__/balance.test.ts
bun test src/__tests__/transaction.test.ts
bun test src/__tests__/api.test.ts
```

## Manual Testing Examples

### Using curl

```bash
# Health check
curl http://localhost:3000/health

# Get balance
curl -X POST http://localhost:3000/balance \
  -H "Content-Type: application/json" \
  -d '{"userId": "user1"}'

# Credit transaction
curl -X POST http://localhost:3000/transact \
  -H "Content-Type: application/json" \
  -d '{
    "idempotentKey": "test-credit-1",
    "userId": "user1",
    "amount": "100",
    "type": "credit"
  }'

# Debit transaction
curl -X POST http://localhost:3000/transact \
  -H "Content-Type: application/json" \
  -d '{
    "idempotentKey": "test-debit-1",
    "userId": "user1",
    "amount": "50",
    "type": "debit"
  }'

# Test idempotency (run the same transaction twice)
curl -X POST http://localhost:3000/transact \
  -H "Content-Type: application/json" \
  -d '{
    "idempotentKey": "test-idempotent-1",
    "userId": "user1",
    "amount": "25",
    "type": "credit"
  }'
```

### Test Insufficient Funds

```bash
# Try to debit more than available balance
curl -X POST http://localhost:3000/transact \
  -H "Content-Type: application/json" \
  -d '{
    "idempotentKey": "test-insufficient-1",
    "userId": "user1",
    "amount": "10000",
    "type": "debit"
  }'
```

## Database Schema

### Table: BalanceTransactions

**Primary Key:**
- Partition Key (PK): `USER#<userId>` or `TXN#<idempotentKey>`
- Sort Key (SK): `BALANCE` or `TXN#<timestamp>#<idempotentKey>`

**GSI (if needed):**
- GSI1: `userId-timestamp-index` (PK: `userId`, SK: `timestamp`)

**Item Types:**

#### Balance Item
```json
{
  "PK": "USER#user123",
  "SK": "BALANCE",
  "userId": "user123",
  "balance": 1000,
  "version": 5,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

#### Transaction Item
```json
{
  "PK": "USER#user123",
  "SK": "TXN#2024-01-01T00:00:00.000Z#txn-123",
  "userId": "user123",
  "idempotentKey": "txn-123",
  "amount": 100,
  "type": "credit",
  "status": "completed",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "balanceAfter": 1100
}
```

#### Idempotency Item
```json
{
  "PK": "TXN#txn-123",
  "SK": "RESULT",
  "idempotentKey": "txn-123",
  "userId": "user123",
  "amount": "100",
  "type": "credit",
  "newBalance": 1100,
  "status": "completed",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "ttl": 1704067200
}
```

## Error Handling

The API returns structured error responses:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Insufficient funds: User user123 has 100 but tried to debit 200"
  }
}
```

**Error Codes:**
- `INVALID_REQUEST`: Missing or invalid request parameters
- `INSUFFICIENT_FUNDS`: Debit amount exceeds available balance
- `DUPLICATE_TRANSACTION`: Transaction already processed (idempotency)
- `RACE_CONDITION`: Concurrent transaction conflict
- `INTERNAL_ERROR`: Unexpected server error

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3000)
- `DYNAMODB_ENDPOINT`: DynamoDB endpoint (default: http://localhost:8000)

### Database Commands

```bash
# Create table and seed data
bun run setup-db create

# Delete table
bun run setup-db delete

# Recreate table (drop and create)
bun run setup-db recreate
```

## Development

### Project Structure

```
src/
├── api/
│   ├── routes.ts      # Hono API routes
│   └── server.ts      # Server entry point
├── db/
│   ├── config.ts      # DynamoDB client configuration
│   └── setup.ts       # Database setup and seeding
├── services/
│   ├── balance.ts     # getCurrentBalance function
│   └── transaction.ts # transact function
├── types/
│   └── index.ts       # TypeScript type definitions
└── __tests__/
    ├── api.test.ts
    ├── balance.test.ts
    └── transaction.test.ts
```

### Key Design Decisions

1. **Single Table Design**: Uses DynamoDB single table design for optimal performance
2. **Idempotency Keys**: Stored as separate items with TTL for cleanup
3. **Atomic Transactions**: Uses DynamoDB `TransactWriteItems` for consistency
4. **Optimistic Locking**: Version numbers prevent concurrent modification issues
5. **TTL Cleanup**: Idempotency records automatically expire after 30 days

### Race Condition Prevention

The system uses multiple layers of protection:

1. **DynamoDB Conditional Writes**: Balance updates only succeed if version matches
2. **Transaction Atomicity**: All related writes happen atomically or not at all
3. **Idempotency Checks**: Duplicate transactions return previous results
4. **Optimistic Locking**: Version numbers detect concurrent modifications

## Contributing

1. Run tests: `bun test`
2. Add new tests for new features
3. Ensure all tests pass before submitting
4. Follow existing code patterns and TypeScript types

## License

This project was created for the JacksClub developer interview assessment.
