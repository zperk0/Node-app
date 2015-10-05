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
var setTimeout = require('timers').setTimeout;

var HyperbahnClient = require('tchannel/hyperbahn/index.js');
var TChannelJSON = require('tchannel/as/json');
// var timers = TimeMock(Date.now());

module.exports = runTests;

if (require.main === module) {
    runTests(require('../lib/test-cluster.js'));
}

function runTests(HyperbahnCluster) {
    HyperbahnCluster.test('advertise and forward with purge period', {
        size: 5,
        servicePurgePeriod: 50
    }, function t(cluster, assert) {
        var steve = cluster.remotes.steve;
        var bob = cluster.remotes.bob;

        var tchannelJSON = TChannelJSON({
            logger: cluster.logger
        });

        var steveHyperbahnClient = new HyperbahnClient({
            serviceName: steve.serviceName,
            callerName: 'forward-test',
            hostPortList: cluster.hostPortList,
            tchannel: steve.channel,
            advertiseInterval: 2,
            logger: DebugLogtron('hyperbahnClient')
        });

        steveHyperbahnClient.once('advertised', onAdvertised);
        steveHyperbahnClient.advertise();

        function onAdvertised() {
            assert.equal(steveHyperbahnClient.state, 'ADVERTISED', 'state should be ADVERTISED');
            setTimeout(function onSend() {
                tchannelJSON.send(bob.clientChannel.request({
                    timeout: 5000,
                    serviceName: steve.serviceName
                }), 'echo', null, 'oh hi lol', onForwarded);
            }, 55);
        }

        function onForwarded(err, resp) {
            assert.ifError(err);
            assert.equal(String(resp.body), 'oh hi lol');

            steveHyperbahnClient.destroy();
            assert.end();
        }
    });
}
