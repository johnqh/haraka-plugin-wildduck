'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { mail, dataPost } = require('../lib/hooks');

describe('Hooks', () => {
    describe('mail hook', () => {
        let plugin, connection, params;

        beforeEach(() => {
            plugin = {
                loggelf: sinon.stub(),
                resolver: sinon.stub(),
                cfg: {
                    auth: {
                        dns: {
                            maxLookups: 10
                        }
                    }
                }
            };

            connection = {
                transaction: {
                    notes: {},
                    uuid: 'test-uuid-123',
                    add_leading_header: sinon.stub()
                },
                auth_results: sinon.stub(),
                remote: {
                    ip: '192.0.2.1',
                    is_private: false
                },
                hello: {
                    host: 'mail.example.com'
                },
                local: {
                    host: 'mx.example.com'
                },
                logerror: sinon.stub()
            };

            params = [{
                address: () => 'sender@example.com'
            }];
        });

        it('should set sender in transaction notes', async () => {
            await mail(plugin, connection, params);
            expect(connection.transaction.notes.sender).to.equal('sender@example.com');
        });

        it('should log MAIL FROM to gelf', async () => {
            await mail(plugin, connection, params);
            expect(plugin.loggelf.calledOnce).to.be.true;
            const logCall = plugin.loggelf.firstCall.args[0];
            expect(logCall._mail_action).to.equal('mail_from');
            expect(logCall._from).to.equal('sender@example.com');
            expect(logCall._queue_id).to.equal('test-uuid-123');
        });

        it('should return false if no transaction', async () => {
            connection.transaction = null;
            const result = await mail(plugin, connection, params);
            expect(result).to.be.false;
        });

        it('should handle existing sender in notes', async () => {
            connection.transaction.notes.sender = 'existing@example.com';
            await mail(plugin, connection, params);
            // Should still be set from params
            expect(connection.transaction.notes.sender).to.equal('sender@example.com');
        });
    });

    describe('dataPost hook', () => {
        let plugin, connection, next;

        beforeEach(() => {
            plugin = {
                loggelf: sinon.stub(),
                resolver: sinon.stub(),
                cfg: {}
            };

            connection = {
                transaction: {
                    notes: {
                        sender: 'sender@example.com'
                    },
                    uuid: 'test-uuid',
                    message_stream: {
                        pipe: sinon.stub().returnsThis()
                    },
                    header: {
                        get_all: sinon.stub().returns([])
                    }
                },
                auth_results: sinon.stub(),
                logerror: sinon.stub()
            };

            next = sinon.stub();
        });

        it('should call next when stream completes', (done) => {
            dataPost(next, plugin, connection);

            // Simulate stream completion
            setTimeout(() => {
                expect(connection.transaction.message_stream.pipe.called).to.be.true;
                done();
            }, 50);
        });

        it('should handle missing transaction', () => {
            connection.transaction = null;
            dataPost(next, plugin, connection);
            expect(next.calledOnce).to.be.true;
        });

        it('should pipe message stream to auth stream', () => {
            dataPost(next, plugin, connection);
            expect(connection.transaction.message_stream.pipe.called).to.be.true;
            const pipeCall = connection.transaction.message_stream.pipe.firstCall;
            expect(pipeCall.args[1]).to.deep.equal({ line_endings: '\r\n' });
        });
    });
});
