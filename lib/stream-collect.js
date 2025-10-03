'use strict';

const Transform = require('stream').Transform;

/**
 * Stream transformer that collects message chunks while passing them through
 * Used to buffer email message data for later processing (forwarding, storage)
 * Maintains chunks array and total length for downstream handlers
 */
class StreamCollect extends Transform {
    /**
     * Create a StreamCollect transformer
     * @param {Object} options - Stream options (passed to Transform)
     */
    constructor(options) {
        super();
        this.options = options || {};
        this.chunks = [];
        this.chunklen = 0;
    }

    /**
     * Transform function that collects and passes through chunks
     * @param {Buffer} chunk - Data chunk from stream
     * @param {string} encoding - Character encoding
     * @param {Function} done - Callback to signal completion
     */
    _transform(chunk, encoding, done) {
        this.chunks.push(chunk);
        this.chunklen += chunk.length;
        this.push(chunk);
        done();
    }
}

module.exports = StreamCollect;
