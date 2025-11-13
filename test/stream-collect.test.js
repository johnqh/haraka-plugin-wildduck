'use strict';

const { expect } = require('chai');
const StreamCollect = require('../lib/stream-collect');

describe('StreamCollect', () => {
    it('should collect chunks while passing them through', (done) => {
        const collector = new StreamCollect();
        const chunks = [Buffer.from('Hello '), Buffer.from('World'), Buffer.from('!')];
        const collected = [];

        collector.on('data', (chunk) => {
            collected.push(chunk);
        });

        collector.on('end', () => {
            expect(collector.chunks).to.have.lengthOf(3);
            expect(collector.chunklen).to.equal(12);
            expect(Buffer.concat(collector.chunks).toString()).to.equal('Hello World!');
            expect(collected).to.have.lengthOf(3);
            expect(Buffer.concat(collected).toString()).to.equal('Hello World!');
            done();
        });

        chunks.forEach(chunk => collector.write(chunk));
        collector.end();
    });

    it('should initialize with empty chunks array', () => {
        const collector = new StreamCollect();
        expect(collector.chunks).to.be.an('array').that.is.empty;
        expect(collector.chunklen).to.equal(0);
    });

    it('should handle single chunk', (done) => {
        const collector = new StreamCollect();
        const chunk = Buffer.from('Single chunk');

        collector.on('data', (data) => {
            expect(data.toString()).to.equal('Single chunk');
        });

        collector.on('end', () => {
            expect(collector.chunks).to.have.lengthOf(1);
            expect(collector.chunklen).to.equal(12);
            done();
        });

        collector.write(chunk);
        collector.end();
    });

    it('should handle empty stream', (done) => {
        const collector = new StreamCollect();

        collector.on('finish', () => {
            expect(collector.chunks).to.be.empty;
            expect(collector.chunklen).to.equal(0);
            done();
        });

        collector.end();
    });

    it('should accumulate chunk lengths correctly', (done) => {
        const collector = new StreamCollect();
        const chunks = [
            Buffer.from('a'),
            Buffer.from('bb'),
            Buffer.from('ccc'),
            Buffer.from('dddd')
        ];

        collector.on('finish', () => {
            expect(collector.chunklen).to.equal(10); // 1 + 2 + 3 + 4
            expect(collector.chunks).to.have.lengthOf(4);
            done();
        });

        chunks.forEach(chunk => collector.write(chunk));
        collector.end();
    });
});
