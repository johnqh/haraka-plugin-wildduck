'use strict';

const { PassThrough } = require('stream');

const { hookMail: authHookMail, hookDataPost: authHookDataPost } = require('./auth');

/**
 * MAIL FROM hook wrapper - logs sender and triggers SPF validation
 * @param {Object} plugin - Plugin instance
 * @param {Object} connection - Haraka connection object
 * @param {Array} params - Hook parameters with sender address
 * @returns {Promise<void>}
 */
async function mail(plugin, connection, params) {
    const txn = connection.transaction;
    if (!txn) {
        return false;
    }

    const from = params[0];
    txn.notes.sender = from.address();

    plugin.loggelf({
        short_message: '[MAIL FROM:' + txn.notes.sender + '] ' + txn.uuid,

        _mail_action: 'mail_from',
        _from: txn.notes.sender,
        _queue_id: txn.uuid,
        _ip: connection.remote.ip,
        _proto: txn.notes.transmissionType
    });

    // SPF check
    await authHookMail(plugin, connection, params);
}

/**
 * DATA POST hook wrapper - creates stream and triggers email authentication
 * Pipes message through PassThrough stream for DKIM verification
 * @param {Function} next - Haraka callback
 * @param {Object} plugin - Plugin instance
 * @param {Object} connection - Haraka connection object
 */
function dataPost(next, plugin, connection) {
    const txn = connection?.transaction;
    if (!txn) {
        return next();
    }

    const stream = new PassThrough();
    authHookDataPost(stream, plugin, connection)
        .then(() => {
            next();
        })
        .catch(err => {
            connection.logerror(plugin, err.message);
            next();
        });

    txn.message_stream.pipe(stream, { line_endings: '\r\n' });
}

module.exports = { mail, dataPost };
