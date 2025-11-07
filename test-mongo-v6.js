#!/usr/bin/env node
'use strict';

/**
 * MongoDB v6 Migration Smoke Test
 *
 * This test verifies that the MongoDB v6 migration is working correctly by:
 * 1. Testing MongoClient.connect() returns the correct type
 * 2. Testing database connection and operations
 * 3. Verifying the db.js module works with MongoDB v6
 *
 * Run with: node test-mongo-v6.js
 *
 * Prerequisites:
 * - MongoDB server running (default: mongodb://localhost:27017)
 * - Redis server running (default: redis://localhost:6379)
 */

const { MongoClient } = require('mongodb');
const db = require('./lib/db');

// Test configuration
const TEST_CONFIG = {
    mongo: {
        url: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/haraka-test',
        gridfs: null, // Will use main database
        users: null,  // Will use main database
        sender: null  // Will use main database
    },
    redis: process.env.REDIS_URL || 'redis://127.0.0.1:6379/13',
    attachments: {
        type: 'gridstore',
        bucket: 'attachments'
    }
};

console.log('\n=== MongoDB v6 Migration Smoke Test ===\n');

// Test 1: Verify MongoClient.connect() behavior
async function testMongoClientConnect() {
    console.log('Test 1: MongoClient.connect() return value');
    console.log('---------------------------------------');

    try {
        const client = await MongoClient.connect(TEST_CONFIG.mongo.url);

        console.log('✓ MongoClient.connect() succeeded');
        console.log(`  Type: ${client.constructor.name}`);
        console.log(`  Has .db() method: ${typeof client.db === 'function'}`);
        console.log(`  Has .close() method: ${typeof client.close === 'function'}`);

        // Try to get a database
        const database = client.db();
        console.log(`✓ client.db() returned: ${database.constructor.name}`);
        console.log(`  Database name: ${database.databaseName}`);

        // Test a simple operation
        const collections = await database.listCollections().toArray();
        console.log(`✓ Database operations work (found ${collections.length} collections)`);

        await client.close();
        console.log('✓ Client closed successfully\n');

        return true;
    } catch (err) {
        console.error('✗ Test 1 FAILED:', err.message);
        console.error('  Stack:', err.stack);
        return false;
    }
}

// Test 2: Test getDBConnection helper pattern
async function testGetDBConnectionPattern() {
    console.log('Test 2: getDBConnection() pattern');
    console.log('----------------------------------');

    try {
        // First connection
        const client = await MongoClient.connect(TEST_CONFIG.mongo.url);
        console.log('✓ Created initial MongoClient');

        // Check if client has internal structure
        if (client.s && client.s.options && client.s.options.dbName) {
            console.log(`✓ Client has dbName: ${client.s.options.dbName}`);
            const database = client.db(client.s.options.dbName);
            console.log(`✓ Extracted Db object: ${database.constructor.name}`);
        } else {
            console.log('  Note: Client does not have dbName in options (normal for connection strings without /dbname)');
            const database = client.db('haraka-test');
            console.log(`✓ Created Db object with explicit name: ${database.constructor.name}`);
        }

        // Test secondary database from main connection
        const secondaryDb = client.db('haraka-test-secondary');
        console.log(`✓ Created secondary Db from same client: ${secondaryDb.constructor.name}`);

        await client.close();
        console.log('✓ Pattern test completed\n');

        return true;
    } catch (err) {
        console.error('✗ Test 2 FAILED:', err.message);
        console.error('  Stack:', err.stack);
        return false;
    }
}

// Test 3: Test the actual db.connect() function
async function testDbConnect() {
    console.log('Test 3: db.connect() function');
    console.log('------------------------------');

    return new Promise((resolve) => {
        db.connect(null, TEST_CONFIG, (err, connections) => {
            if (err) {
                console.error('✗ Test 3 FAILED:', err.message);
                console.error('  Stack:', err.stack);
                resolve(false);
                return;
            }

            try {
                console.log('✓ db.connect() succeeded');
                console.log(`  Database: ${connections.database ? connections.database.constructor.name : 'MISSING'}`);
                console.log(`  Database name: ${connections.database ? connections.database.databaseName : 'N/A'}`);
                console.log(`  GridFS: ${connections.gridfs ? connections.gridfs.constructor.name : 'MISSING'}`);
                console.log(`  Users DB: ${connections.users ? connections.users.constructor.name : 'MISSING'}`);
                console.log(`  Sender DB: ${connections.senderDb ? connections.senderDb.constructor.name : 'MISSING'}`);
                console.log(`  Redis: ${connections.redis ? connections.redis.constructor.name : 'MISSING'}`);
                console.log(`  UserHandler: ${connections.userHandler ? connections.userHandler.constructor.name : 'MISSING'}`);
                console.log(`  MessageHandler: ${connections.messageHandler ? connections.messageHandler.constructor.name : 'MISSING'}`);
                console.log(`  SettingsHandler: ${connections.settingsHandler ? connections.settingsHandler.constructor.name : 'MISSING'}`);

                // Verify all required components exist
                const required = ['database', 'gridfs', 'users', 'senderDb', 'redis', 'userHandler', 'messageHandler', 'settingsHandler'];
                const missing = required.filter(key => !connections[key]);

                if (missing.length > 0) {
                    console.error(`✗ Missing required components: ${missing.join(', ')}`);
                    resolve(false);
                } else {
                    console.log('✓ All required components initialized');

                    // Test a simple database operation
                    connections.database.listCollections().toArray()
                        .then(collections => {
                            console.log(`✓ Database operations work (found ${collections.length} collections)`);

                            // Clean up
                            if (connections.redis) {
                                connections.redis.quit();
                            }

                            console.log('✓ Test completed successfully\n');
                            resolve(true);
                        })
                        .catch(err => {
                            console.error('✗ Database operation failed:', err.message);
                            resolve(false);
                        });
                }
            } catch (err) {
                console.error('✗ Test 3 FAILED:', err.message);
                console.error('  Stack:', err.stack);
                resolve(false);
            }
        });
    });
}

// Run all tests
async function runTests() {
    const results = [];

    results.push(await testMongoClientConnect());
    results.push(await testGetDBConnectionPattern());
    results.push(await testDbConnect());

    console.log('=== Test Summary ===');
    console.log(`Passed: ${results.filter(r => r).length}/${results.length}`);
    console.log(`Failed: ${results.filter(r => !r).length}/${results.length}`);

    if (results.every(r => r)) {
        console.log('\n✓ All tests PASSED! MongoDB v6 migration is successful.\n');
        process.exit(0);
    } else {
        console.log('\n✗ Some tests FAILED. Please review the output above.\n');
        process.exit(1);
    }
}

// Handle connection errors
process.on('unhandledRejection', (err) => {
    console.error('\n✗ Unhandled rejection:', err.message);
    console.error('  Stack:', err.stack);
    process.exit(1);
});

// Run tests
runTests().catch(err => {
    console.error('\n✗ Fatal error:', err.message);
    console.error('  Stack:', err.stack);
    process.exit(1);
});
