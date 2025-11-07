'use strict';

const mongodb = require('mongodb');
const Redis = require('ioredis');
const MongoClient = mongodb.MongoClient;
const UserHandler = require('@johnqh/wildduck/lib/user-handler');
const MessageHandler = require('@johnqh/wildduck/lib/message-handler');
const { SettingsHandler } = require('@johnqh/wildduck/lib/settings-handler');
const counters = require('@johnqh/wildduck/lib/counters');
const tools = require('@johnqh/wildduck/lib/tools');

/**
 * Establish a MongoDB connection
 * Supports connection strings or database names within existing connection
 * @param {Object} main - Existing MongoDB connection (if any)
 * @param {string} config - Connection string or database name
 * @returns {Promise<Object>} Database connection
 */
const getDBConnection = async (main, config) => {
    if (main) {
        if (!config) {
            return false;
        }
        if (config && !/[:/]/.test(config)) {
            return main.db(config);
        }
    }
    let db = await MongoClient.connect(config);
    if (main && db.s && db.s.options && db.s.options.dbName) {
        db = db.db(db.s.options.dbName);
    }
    return db;
};

/**
 * Connect to all required databases and initialize WildDuck handlers
 * Sets up MongoDB connections for main, gridfs, users, and sender databases
 * Initializes Redis connection and creates UserHandler, MessageHandler, SettingsHandler
 * @param {Object} redis - Redis configuration (unused, kept for compatibility)
 * @param {Object} config - Configuration object with mongo and redis settings
 * @param {Function} callback - Callback with (err, connectionObject)
 * @returns {Object} Connection object with database, gridfs, users, senderDb, redis, handlers
 */
module.exports.connect = (redis, config, callback) => {
    // Use an async IIFE to use await while still supporting callbacks
    (async () => {
        try {
            const response = {};

            // main connection
            const db = await getDBConnection(false, config.mongo.url);

            if (db.s && db.s.options && db.s.options.dbName) {
                response.database = db.db(db.s.options.dbName);
            } else {
                response.database = db;
            }

            // gridfs connection
            const gdb = await getDBConnection(db, config.mongo.gridfs);
            response.gridfs = gdb || response.database;

            // users connection
            const udb = await getDBConnection(db, config.mongo.users);
            response.users = udb || response.database;

            // sender connection
            const sdb = await getDBConnection(db, config.mongo.sender);
            response.senderDb = sdb || response.database;

            // initialize Redis
            response.redis = new Redis(tools.redisConfig(config.redis));

            // initialize handlers
            response.messageHandler = new MessageHandler({
                database: response.database,
                users: response.users,
                redis: response.redis,
                gridfs: response.gridfs,
                attachments: config.attachments
            });

            response.userHandler = new UserHandler({
                database: response.database,
                users: response.users,
                redis: response.redis,
                gridfs: response.gridfs
            });

            response.settingsHandler = new SettingsHandler({ db: response.database });

            response.ttlcounter = counters(response.redis).ttlcounter;

            return callback(null, response);
        } catch (err) {
            return callback(err);
        }
    })();
};
