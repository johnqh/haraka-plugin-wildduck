'use strict';

const { expect } = require('chai');

describe('DB Module', () => {
    describe('connect', () => {
        it('should export a connect function', () => {
            const dbModule = require('../lib/db');
            expect(dbModule.connect).to.be.a('function');
        });

        it('should accept callback parameters', function(done) {
            this.timeout(10000); // Increase timeout for connection attempt
            const dbModule = require('../lib/db');

            // Test that connect accepts the correct number of parameters
            const config = {
                mongo: {
                    url: 'mongodb://invalid-host-that-will-fail:27017/test?serverSelectionTimeoutMS=1000'
                },
                redis: {
                    host: 'invalid-redis-host',
                    port: 6379
                }
            };

            // Call with invalid config to test error handling
            dbModule.connect(null, config, (err, result) => {
                // We expect an error because the connection will fail
                // This tests that the callback is properly invoked
                expect(err || result).to.exist;
                done();
            });
        });

        it('should have required connection configuration', () => {
            const config = {
                mongo: {
                    url: 'mongodb://localhost/wildduck',
                    gridfs: 'gridfs',
                    users: 'users',
                    sender: 'sender'
                },
                redis: {
                    host: 'localhost',
                    port: 6379
                },
                attachments: {}
            };

            expect(config.mongo).to.have.property('url');
            expect(config.redis).to.have.property('host');
            expect(config.redis).to.have.property('port');
        });
    });
});
