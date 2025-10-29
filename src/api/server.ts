import app from './routes.js';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`🚀 Server starting on port ${port}`);
console.log(`📊 Make sure DynamoDB Local is running on http://localhost:8000`);
console.log(`💡 API endpoints:`);
console.log(`   GET  /health - Health check`);
console.log(`   POST /balance - Get user balance`);
console.log(`   POST /transact - Process transaction`);

export default {
    port,
    fetch: app.fetch,
};

