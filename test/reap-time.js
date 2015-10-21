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

var setTimeout = require('timers').setTimeout;

var allocCluster = require('./lib/test-cluster.js');
var parallel = require('run-parallel');
var CollapsedAssert = require('./lib/collapsed-assert');

var NUM_REMOTES = 5000;
var BATCH_SIZE = 100;

allocCluster.test('make sure peer reaper doesnt take too long', {
    size: 10,
    kValue: 1,
    whitelist: [
        ['info', 'not setting peer reap timer'],
        ['warn', 'stale tombstone']
    ]
}, function t(cluster, assert) {
    var i;
    var batch = 1;
    var todo = NUM_REMOTES + 1;
    var remotes = [];
    var cassert = CollapsedAssert();

    remoteDone(null);

    function remoteDone(err) {
        cassert.ifError(err);

        todo--;
        batch--;

        if (todo <= 0) {
            doneCreating();
            return;
        }

        if (batch <= 0) {
            console.log("# finished batch");
            batch = BATCH_SIZE;
            for (i = 0; i < BATCH_SIZE; i++) {
                remotes.push(cluster.createRemote({
                    serviceName: 'api',
                    trace: false
                }, remoteDone));
            }
        }
    }

    function doneCreating() {
        console.log("# done creating remotes");
        cassert.report(assert, 'remote creation successful');

        var apiExitNode = cluster.getExitNodes('api')[0];
        var start = Date.now();
        apiExitNode.clients.serviceProxy.reapPeers();
        apiExitNode.clients.serviceProxy.reapPeers();
        var end = Date.now();
        console.log("# done reaping peers", end - start);

        finish();
    }

    function finish() {
        for (i = 0; i < remotes.length; i++) {
            remotes[i].destroy();
        }
        assert.end();
    }
});
