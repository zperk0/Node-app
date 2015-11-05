// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var DebugLogtron = require('debug-logtron');
var fs = require('fs');
var path = require('path');

var TChannelAsThrift = require('tchannel/as/thrift');
var HyperbahnClient = require('tchannel/hyperbahn/index.js');

var source = fs.readFileSync(path.join(__dirname, '../../hyperbahn.thrift'), 'utf8');
var thrift = new TChannelAsThrift({source: source});

module.exports = runTests;

if (require.main === module) {
    runTests(require('../lib/test-cluster.js'));
}

function covertHost(host) {
    var res = '';
    res += ((host.ip.ipv4 & 0xff000000) >> 24) + '.';
    res += ((host.ip.ipv4 & 0xff0000) >> 16) + '.';
    res += ((host.ip.ipv4 & 0xff00) >> 8) + '.';
    res += host.ip.ipv4 & 0xff;
    return res + ':' + host.port;
}

function runTests(HyperbahnCluster) {
    HyperbahnCluster.test('get no host', {
        size: 15
    }, function t(cluster, assert) {
        var bob = cluster.remotes.bob;
        var bobSub = bob.channel.subChannels.hyperbahn;
        var request = bobSub.request({
            headers: {
                cn: 'test'
            },
            serviceName: 'hyperbahn',
            hasNoParent: true
        });
        thrift.send(request,
            'Hyperbahn::discover',
            null,
            {
                query: {
                    serviceName: 'matt'
                }
            },
            onResponse
        );
        function onResponse(err, res) {
            if (err) {
                assert.end(err);
            }
            assert.ok(res, 'should be a result');
            assert.ok(!res.ok, 'result should not be ok');
            assert.equals(res.body.message, 'no peer available for matt', 'error message as expected');
            assert.end();
        }
    });

    HyperbahnCluster.test('get host port as expected', {
        size: 5
    }, function t(cluster, assert) {
        var bob = cluster.remotes.bob;
        var steve = cluster.remotes.steve;
        var steveSub = steve.channel.subChannels.hyperbahn;
        var request = steveSub.request({
            headers: {
                cn: 'test'
            },
            serviceName: 'hyperbahn',
            hasNoParent: true
        });

        var client = new HyperbahnClient({
            serviceName: 'hello-bob',
            callerName: 'hello-bob-test',
            hostPortList: cluster.hostPortList,
            tchannel: bob.channel,
            logger: DebugLogtron('hyperbahnClient')
        });

        client.once('advertised', onResponse);
        client.advertise();

        function onResponse() {
            thrift.send(request,
                'Hyperbahn::discover',
                null,
                {
                    query: {
                        serviceName: 'hello-bob'
                    }
                },
                check
            );
        }

        function check(err, res) {
            if (err) {
                assert.end(err);
            }
            assert.ok(res, 'should be a result');
            assert.ok(res.ok, 'result should be ok');
            assert.equals(covertHost(res.body.peers[0]), bob.channel.hostPort,
                'should get the expected hostPort');
            client.destroy();
            assert.end();
        }
    });

    HyperbahnCluster.test('malformed thrift IDL: empty serviceName', {
        size: 5
    }, function t(cluster, assert) {
        var bob = cluster.remotes.bob;
        var bobSub = bob.channel.subChannels.hyperbahn;
        var request = bobSub.request({
            headers: {
                cn: 'test'
            },
            serviceName: 'hyperbahn',
            hasNoParent: true
        });
        thrift.send(request,
            'Hyperbahn::discover',
            null,
            {
                query: {
                    serviceName: ''
                }
            },
            onResponse
        );
        function onResponse(err, res) {
            if (err) {
                assert.end(err);
            }
            assert.ok(!res.ok, 'should not be ok');
            assert.equals(res.body.message, 'invalid service name: ', 'error message as expected');
            assert.end();
        }
    });

    HyperbahnCluster.test('malformed thrift IDL: an empty body', {
        size: 5
    }, function t(cluster, assert) {
        cluster.logger.whitelist('warn', 'Got unexpected invalid thrift for arg3');
        var bob = cluster.remotes.bob;
        var bobSub = bob.channel.subChannels.hyperbahn;
        var request = bobSub.request({
            headers: {
                cn: 'test'
            },
            serviceName: 'hyperbahn',
            hasNoParent: true
        });
        var badSource = fs.readFileSync(path.join(__dirname, 'bad-hyperbahn-empty-req-body.thrift'), 'utf8');
        var badThrift = new TChannelAsThrift({source: badSource});
        badThrift.send(request,
            'Hyperbahn::discover',
            null,
            {},
            onResponse
        );
        function onResponse(err, res) {
            assert.ok(err, 'should be error');
            assert.equals(err.type, 'tchannel.bad-request', 'error should be bad request');
            assert.ok(err.message.indexOf(
                'tchannel-thrift-handler.parse-error.body-failed: Could not parse body (arg3) argument.\n' +
                'Expected Thrift encoded arg3 for endpoint Hyperbahn::discover.') === 0,
                'error message should be a parsing failure');
            assert.ok(err.message.indexOf(
                'Parsing error was: missing required field "query" with id 1 on discover_args') !== -1,
                'error message should be a parsing failure');

            var items = cluster.logger.items();
            assert.ok(items.length > 0 && items[0].msg === 'Got unexpected invalid thrift for arg3',
                'Do not miss the error log');

            assert.end();
        }
    });

    HyperbahnCluster.test('malformed thrift IDL: a body with a query without the serviceName field', {
        size: 5
    }, function t(cluster, assert) {
        cluster.logger.whitelist('warn', 'Got unexpected invalid thrift for arg3');
        var bob = cluster.remotes.bob;
        var bobSub = bob.channel.subChannels.hyperbahn;
        var request = bobSub.request({
            headers: {
                cn: 'test'
            },
            serviceName: 'hyperbahn',
            hasNoParent: true
        });
        var badSource = fs.readFileSync(path.join(__dirname, 'bad-hyperbahn-empty-query.thrift'), 'utf8');
        var badThrift = new TChannelAsThrift({source: badSource});
        badThrift.send(request,
            'Hyperbahn::discover',
            null,
            {query: {}},
            onResponse
        );
        function onResponse(err, res) {
            assert.ok(err, 'should be error');
            assert.equals(err.type, 'tchannel.bad-request', 'error should be bad request');
            assert.ok(err.message.indexOf(
                'tchannel-thrift-handler.parse-error.body-failed: Could not parse body (arg3) argument.\n' +
                'Expected Thrift encoded arg3 for endpoint Hyperbahn::discover.') === 0,
                'error message should be a parsing failure');
            assert.ok(
                err.message.indexOf(
                    'Parsing error was: missing required field "serviceName" with id 1 on DiscoveryQuery.') !== -1,
                'error message should be a parsing failure');

            var items = cluster.logger.items();
            assert.ok(items.length > 0 && items[0].msg === 'Got unexpected invalid thrift for arg3',
                'Do not miss the error log');

            assert.end();
        }
    });

    HyperbahnCluster.test('malformed thrift IDL: empty serviceName with no exception defined', {
        size: 5
    }, function t(cluster, assert) {
        cluster.logger.whitelist('warn', 'Got unexpected invalid thrift for arg3');
        var bob = cluster.remotes.bob;
        var bobSub = bob.channel.subChannels.hyperbahn;
        var request = bobSub.request({
            headers: {
                cn: 'test'
            },
            serviceName: 'hyperbahn',
            hasNoParent: true
        });
        var badSource = fs.readFileSync(path.join(__dirname, 'bad-hyperbahn-no-exception.thrift'), 'utf8');
        var badThrift = new TChannelAsThrift({source: badSource});
        badThrift.send(request,
            'Hyperbahn::discover',
            null,
            {
                query: {
                    serviceName: ''
                }
            },
            onResponse
        );
        function onResponse(err, res) {
            // TODO expect UnrecognizedException
            assert.ok(err || !res.ok, 'should be error (possibly unrecognized application error)');

            assert.end();
        }
    });
}
