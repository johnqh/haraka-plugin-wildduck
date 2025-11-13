'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const plugin = require('../index');

describe('WildDuck Plugin', () => {
    describe('normalize_address', () => {
        beforeEach(() => {
            plugin.cfg = {};
        });

        it('should normalize regular email addresses', () => {
            const address = {
                user: 'test.user',
                host: 'Example.COM',
                address: () => 'test.user@Example.COM'
            };
            const result = plugin.normalize_address(address);
            expect(result).to.equal('test.user@example.com');
        });

        it('should handle SRS addresses with correct case', () => {
            const address = {
                user: 'SRS0=abcd=12=AB=user',
                host: 'example.com',
                address: () => 'SRS0=abcd=12=AB=user@example.com'
            };
            const result = plugin.normalize_address(address);
            expect(result).to.include('SRS0');
        });

        it('should fix case-mangled SRS addresses', () => {
            const address = {
                user: 'srs0=abcd=12=ab=user',
                host: 'example.com',
                address: () => 'srs0=abcd=12=ab=user@example.com'
            };
            const result = plugin.normalize_address(address);
            expect(result).to.match(/^SRS0/);
        });

        it('should handle Unicode domains', () => {
            const address = {
                user: 'user',
                host: 'xn--e1afmkfd.xn--p1ai',
                address: () => 'user@xn--e1afmkfd.xn--p1ai'
            };
            const result = plugin.normalize_address(address);
            expect(result).to.be.a('string');
        });
    });

    describe('getHeaderFrom', () => {
        it('should extract From header address', () => {
            const txn = {
                header: {
                    get_all: sinon.stub().withArgs('From').returns(['John Doe <john@example.com>'])
                }
            };
            const result = plugin.getHeaderFrom(txn);
            expect(result).to.be.an('object');
            expect(result.address).to.equal('john@example.com');
        });

        it('should handle multiple From headers (take first)', () => {
            const txn = {
                header: {
                    get_all: sinon.stub().withArgs('From').returns([
                        'first@example.com',
                        'second@example.com'
                    ])
                }
            };
            const result = plugin.getHeaderFrom(txn);
            expect(result).to.be.an('object');
            expect(result.address).to.equal('first@example.com');
        });

        it('should handle empty From header', () => {
            const txn = {
                header: {
                    get_all: sinon.stub().withArgs('From').returns([])
                }
            };
            const result = plugin.getHeaderFrom(txn);
            expect(result).to.be.undefined;
        });

        it('should decode encoded names', () => {
            const txn = {
                header: {
                    get_all: sinon.stub().withArgs('From').returns(['=?UTF-8?Q?J=C3=B6hn?= <john@example.com>'])
                }
            };
            const result = plugin.getHeaderFrom(txn);
            expect(result).to.be.an('object');
            expect(result.provided.name).to.include('hn');
        });

        it('should handle group syntax', () => {
            const txn = {
                header: {
                    get_all: sinon.stub().withArgs('From').returns(['Group: user1@example.com, user2@example.com;'])
                }
            };
            const result = plugin.getHeaderFrom(txn);
            expect(result).to.be.an('object');
            expect(result.address).to.match(/@example\.com$/);
        });
    });

    describe('rspamdSymbols', () => {
        it('should extract symbols with scores', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'DKIM_SIGNED': 0,
                            'DKIM_VALID': -0.1,
                            'SPAM_SYMBOL': 5.0
                        }
                    }]
                ])
            };
            const result = plugin.rspamdSymbols(txn);
            expect(result).to.be.an('array').with.lengthOf(2);
            expect(result.find(s => s.key === 'DKIM_VALID')).to.exist;
            expect(result.find(s => s.key === 'SPAM_SYMBOL')).to.exist;
            expect(result.find(s => s.key === 'DKIM_SIGNED')).to.not.exist; // score is 0
        });

        it('should handle object-style symbols', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'TEST_SYMBOL': { score: 2.5, description: 'Test' }
                        }
                    }]
                ])
            };
            const result = plugin.rspamdSymbols(txn);
            expect(result).to.have.lengthOf(1);
            expect(result[0].score).to.equal(2.5);
        });

        it('should handle missing rspamd results', () => {
            const txn = {
                results: new Map()
            };
            const result = plugin.rspamdSymbols(txn);
            expect(result).to.be.an('array').that.is.empty;
        });

        it('should filter out zero scores', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'ZERO_SCORE': 0,
                            'NONZERO_SCORE': 0.1
                        }
                    }]
                ])
            };
            const result = plugin.rspamdSymbols(txn);
            expect(result).to.have.lengthOf(1);
            expect(result[0].key).to.equal('NONZERO_SCORE');
        });
    });

    describe('checkRspamdBlacklist', () => {
        beforeEach(() => {
            plugin.rspamd = {
                blacklist: ['BLACKLIST_SYMBOL', 'ANOTHER_BAD']
            };
        });

        it('should return symbol if found in blacklist with positive score', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'BLACKLIST_SYMBOL': 5.0
                        }
                    }]
                ])
            };
            const result = plugin.checkRspamdBlacklist(txn);
            expect(result).to.be.an('object');
            expect(result.key).to.equal('BLACKLIST_SYMBOL');
            expect(result.value).to.equal(5.0);
        });

        it('should return false if symbol score is zero', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'BLACKLIST_SYMBOL': 0
                        }
                    }]
                ])
            };
            const result = plugin.checkRspamdBlacklist(txn);
            expect(result).to.be.false;
        });

        it('should return false if blacklisted symbol not present', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'SOME_OTHER_SYMBOL': 10.0
                        }
                    }]
                ])
            };
            const result = plugin.checkRspamdBlacklist(txn);
            expect(result).to.be.false;
        });

        it('should return false if no rspamd results', () => {
            const txn = {
                results: new Map()
            };
            const result = plugin.checkRspamdBlacklist(txn);
            expect(result).to.be.false;
        });

        it('should handle object-style symbols', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'BLACKLIST_SYMBOL': { score: 3.5 }
                        }
                    }]
                ])
            };
            const result = plugin.checkRspamdBlacklist(txn);
            expect(result).to.be.an('object');
            expect(result.key).to.equal('BLACKLIST_SYMBOL');
        });
    });

    describe('checkRspamdSoftlist', () => {
        beforeEach(() => {
            plugin.rspamd = {
                softlist: ['SOFTLIST_SYMBOL', 'TEMP_FAIL']
            };
        });

        it('should return symbol if found in softlist with positive score', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'SOFTLIST_SYMBOL': 2.0
                        }
                    }]
                ])
            };
            const result = plugin.checkRspamdSoftlist(txn);
            expect(result).to.be.an('object');
            expect(result.key).to.equal('SOFTLIST_SYMBOL');
        });

        it('should return false if not in softlist', () => {
            const txn = {
                results: new Map([
                    ['rspamd', {
                        symbols: {
                            'OTHER_SYMBOL': 5.0
                        }
                    }]
                ])
            };
            const result = plugin.checkRspamdSoftlist(txn);
            expect(result).to.be.false;
        });
    });

    describe('dsnSpamResponse', () => {
        beforeEach(() => {
            plugin.rspamd = {
                responses: {
                    'CUSTOM_REJECT': 'Custom rejection message for {host}'
                }
            };
        });

        it('should use custom message if configured', () => {
            const txn = {
                notes: {
                    sender: 'user@example.com'
                },
                header: {
                    get_all: sinon.stub().returns([])
                }
            };
            const result = plugin.dsnSpamResponse(txn, 'CUSTOM_REJECT');
            expect(result.reply).to.include('Custom rejection message');
        });

        it('should replace {host} placeholder with sender domain', () => {
            const txn = {
                notes: {
                    sender: 'user@example.com'
                },
                header: {
                    get_all: sinon.stub().returns(['sender@test.com'])
                }
            };
            const result = plugin.dsnSpamResponse(txn, 'CUSTOM_REJECT');
            expect(result.reply).to.include('test.com');
        });

        it('should use default message if no custom message configured', () => {
            const txn = {
                notes: {
                    sender: 'user@example.com'
                },
                header: {
                    get_all: sinon.stub().returns([])
                }
            };
            const result = plugin.dsnSpamResponse(txn, 'UNKNOWN_KEY');
            expect(result.reply).to.include('unsolicited mail');
        });
    });

    describe('getReferencedUsers', () => {
        it('should find users referenced in To and Cc headers', () => {
            const txn = {
                notes: {
                    targets: {
                        users: new Map([
                            ['user1', { recipient: 'recipient1@example.com' }],
                            ['user2', { recipient: 'recipient2@example.com' }]
                        ])
                    }
                },
                header: {
                    get_all: (header) => {
                        if (header === 'To') return ['recipient1@example.com'];
                        if (header === 'Cc') return ['recipient2@example.com'];
                        return [];
                    }
                }
            };
            const result = plugin.getReferencedUsers(txn);
            expect(result).to.be.a('Set');
            expect(result.size).to.equal(2);
        });

        it('should handle empty To and Cc headers', () => {
            const txn = {
                notes: {
                    targets: {
                        users: new Map()
                    }
                },
                header: {
                    get_all: () => []
                }
            };
            const result = plugin.getReferencedUsers(txn);
            expect(result).to.be.a('Set');
            expect(result.size).to.equal(0);
        });

        it('should not include unreferenced users', () => {
            const txn = {
                notes: {
                    targets: {
                        users: new Map([
                            ['user1', { recipient: 'recipient1@example.com' }],
                            ['user2', { recipient: 'recipient2@example.com' }]
                        ])
                    }
                },
                header: {
                    get_all: (header) => {
                        if (header === 'To') return ['recipient1@example.com'];
                        return [];
                    }
                }
            };
            const result = plugin.getReferencedUsers(txn);
            expect(result.size).to.equal(1);
        });
    });

    describe('init_wildduck_transaction', () => {
        it('should initialize transaction notes', async () => {
            plugin.db = {
                settingsHandler: {
                    getMulti: sinon.stub().resolves({
                        'const:max:storage': 1024,
                        'const:max:recipients': 100,
                        'const:max:forwards': 50
                    })
                }
            };

            const connection = {
                transaction: {
                    notes: {},
                    uuid: 'test-uuid'
                },
                greeting: 'EHLO',
                tls_cipher: 'TLS_AES_128_GCM_SHA256'
            };

            await plugin.init_wildduck_transaction(connection);
            const txn = connection.transaction;

            expect(txn.notes.id).to.exist;
            expect(txn.notes.rateKeys).to.be.an('array');
            expect(txn.notes.targets).to.be.an('object');
            expect(txn.notes.targets.users).to.be.instanceOf(Map);
            expect(txn.notes.targets.forwards).to.be.instanceOf(Map);
            expect(txn.notes.targets.recipients).to.be.instanceOf(Set);
            expect(txn.notes.transmissionType).to.equal('ESMTPS');
        });

        it('should not reinitialize if already initialized', async () => {
            plugin.db = {
                settingsHandler: {
                    getMulti: sinon.stub().resolves({})
                }
            };

            const connection = {
                transaction: {
                    notes: {
                        id: 'existing-id'
                    }
                }
            };

            await plugin.init_wildduck_transaction(connection);
            expect(connection.transaction.notes.id).to.equal('existing-id');
        });

        it('should detect SMTP vs ESMTP', async () => {
            plugin.db = {
                settingsHandler: {
                    getMulti: sinon.stub().resolves({})
                }
            };

            const connection = {
                transaction: {
                    notes: {}
                },
                greeting: 'HELO',
                tls_cipher: null
            };

            await plugin.init_wildduck_transaction(connection);
            expect(connection.transaction.notes.transmissionType).to.equal('SMTP');
        });
    });
});
