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

var fs = require('fs');
var setTimeout = require('timers').setTimeout;

var allocCluster = require('../lib/test-cluster.js');

allocCluster.test('tchannel heap dumps', function t(cluster, assert) {
    var app = cluster.apps[0];

    cluster.logger.whitelist('warn', 'write a heapsnapshot');

    app.client.sendHeapDump(function onResponse(err, resp) {
        assert.ifError(err, 'send heap dump got an error');

        assert.ok(resp.body.path, 'heap dump does not return path');

        var logs = cluster.logger.items();
        assert.ok(logs.some(function findExpected(log) {
            return log.msg === 'write a heapsnapshot' &&
                   log.meta.file === resp.body.path;
        }));

        setTimeout(onTimeout, 1000);

        function onTimeout() {
            fs.unlink(resp.body.path, assert.end);
        }
    });
});
