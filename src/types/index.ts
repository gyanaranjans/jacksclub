// Core types for the balance and transaction system

export type TransactionType = 'credit' | 'debit';

export interface GetBalanceRequest {
    userId: string;
}

export interface TransactRequest {
    idempotentKey: string;
    userId: string;
    amount: string;
    type: TransactionType;
}

export interface BalanceResponse {
    userId: string;
    balance: number;
}

export interface TransactionResponse {
    success: boolean;
    idempotentKey: string;
    userId: string;
    amount: string;
    type: TransactionType;
    newBalance: number;
    message?: string;
}

// DynamoDB item types
export interface BalanceItem {
    PK: string; // USER#<userId>
    SK: string; // BALANCE
    userId: string;
    balance: number;
    version: number; // For optimistic locking
    createdAt: string;
    updatedAt: string;
}

export interface TransactionItem {
    PK: string; // USER#<userId>
    SK: string; // TXN#<timestamp>#<idempotentKey>
    userId: string;
    idempotentKey: string;
    amount: number;
    type: TransactionType;
    status: 'completed' | 'failed';
    timestamp: string;
    balanceAfter: number;
}

// Idempotency key tracking
export interface IdempotencyItem {
    PK: string; // TXN#<idempotentKey>
    SK: string; // RESULT
    idempotentKey: string;
    userId: string;
    amount: string;
    type: TransactionType;
    newBalance: number;
    status: 'completed' | 'failed';
    timestamp: string;
    ttl?: number; // Optional TTL for cleanup
}

// Error types
export class BalanceError extends Error {
    constructor(message: string, public code: string) {
        super(message);
        this.name = 'BalanceError';
    }
}

export class InsufficientFundsError extends BalanceError {
    constructor(userId: string, currentBalance: number, requestedAmount: number) {
        super(
            `Insufficient funds: User ${userId} has ${currentBalance} but tried to debit ${requestedAmount}`,
            'INSUFFICIENT_FUNDS'
        );
    }
}

export class DuplicateTransactionError extends BalanceError {
    constructor(idempotentKey: string) {
        super(
            `Duplicate transaction: Idempotent key ${idempotentKey} already processed`,
            'DUPLICATE_TRANSACTION'
        );
    }
}

export class InvalidAmountError extends BalanceError {
    constructor(amount: string) {
        super(`Invalid amount: ${amount} must be a positive number`, 'INVALID_AMOUNT');
    }
}

export class RaceConditionError extends BalanceError {
    constructor(userId: string) {
        super(
            `Race condition detected for user ${userId}. Please retry the transaction.`,
            'RACE_CONDITION'
        );
    }
}

// Type-only exports for when we only need types
export type { BalanceError as BalanceErrorType };
export type { InsufficientFundsError as InsufficientFundsErrorType };
export type { DuplicateTransactionError as DuplicateTransactionErrorType };
export type { InvalidAmountError as InvalidAmountErrorType };
export type { RaceConditionError as RaceConditionErrorType };
