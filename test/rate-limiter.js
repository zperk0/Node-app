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
var test = require('tape');
var TimeMock = require('time-mock');
var nullStatsd = require('uber-statsd-client/null');
var series = require('run-series');
var TChannel = require('tchannel');

var RateLimiter = require('../rate_limiter.js');

var timers = TimeMock(Date.now());

function increment(rateLimiter, steve, bob, done) {
    if (steve) {
        rateLimiter.incrementTotalCounter('steve');
        rateLimiter.incrementServiceCounter('steve');
        rateLimiter.incrementKillSwitchCounter('steve');
    }

    if (bob) {
        rateLimiter.incrementTotalCounter('bob');
        rateLimiter.incrementServiceCounter('bob');
        rateLimiter.incrementKillSwitchCounter('bob');
    }

    if (done) {
        done();
    }
}

function wait(done) {
    timers.setTimeout(done, 500);
    timers.advance(500);
}

test('rps counter works', function t(assert) {
    var channel = new TChannel({
        timers: timers,
        statsd: nullStatsd(2)
    });
    var statsd = channel.statsd;
    var rateLimiter = RateLimiter({
        numOfBuckets: 2,
        channel: channel
    });

    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve');

    assert.equals(rateLimiter.totalRequestCounter.rps, 5, 'total request');
    assert.equals(rateLimiter.serviceCounters.steve.rps, 3, 'request for steve');
    assert.equals(rateLimiter.ksCounters.steve.rps, 3, 'request for steve - kill switch');
    assert.equals(rateLimiter.serviceCounters.bob.rps, 2, 'request for bob');
    assert.equals(rateLimiter.ksCounters.bob.rps, 2, 'request for bob - kill switch');

    channel.flushStats();
    assert.deepEqual(statsd._buffer._elements, [{
        type: 'g',
        name: 'tchannel.rate-limiting.total-rps-limit',
        value: 1000,
        delta: null,
        time: null
    }], 'stats keys/values as expected');

    rateLimiter.destroy();
    assert.end();
    channel.close();
});

test('rps counter works in 1.5 seconds', function t(assert) {
    var channel = new TChannel({
        timers: timers,
        statsd: nullStatsd(18)
    });
    var statsd = channel.statsd;
    var rateLimiter = RateLimiter({
        numOfBuckets: 2,
        channel: channel
    });

    series([
        increment.bind(null, rateLimiter, 'steve', 'bob'),
        increment.bind(null, rateLimiter, 'steve', 'bob'),
        wait,
        increment.bind(null, rateLimiter, 'steve', null),
        function check1(done) {
            assert.equals(rateLimiter.totalRequestCounter.rps, 5, 'check1: total request');
            assert.equals(rateLimiter.serviceCounters.steve.rps, 3, 'check1: request for steve');
            assert.equals(rateLimiter.ksCounters.steve.rps, 3, 'check1: request for steve - kill switch');
            assert.equals(rateLimiter.serviceCounters.bob.rps, 2, 'check1: request for bob');
            assert.equals(rateLimiter.ksCounters.bob.rps, 2, 'check1: request for bob - kill switch');
            done();
        },
        wait,
        increment.bind(null, rateLimiter, 'steve', 'bob'),
        function check2(done) {
            assert.equals(rateLimiter.totalRequestCounter.rps, 3, 'check2: total request');
            assert.equals(rateLimiter.serviceCounters.steve.rps, 2, 'check2: request for steve');
            assert.equals(rateLimiter.ksCounters.steve.rps, 2, 'check2: request for steve - kill switch');
            assert.equals(rateLimiter.serviceCounters.bob.rps, 1, 'check2: request for bob');
            assert.equals(rateLimiter.ksCounters.bob.rps, 1, 'check2: request for bob - kill switch');
            done();
        }
    ], function done() {
        if (!rateLimiter.destroyed) {
            channel.flushStats();
            assert.deepEqual(statsd._buffer._elements, [{
                type: 'g',
                name: 'tchannel.rate-limiting.total-rps-limit',
                value: 1000,
                delta: null,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.total-rps',
                value: null,
                delta: 5,
                time: null
            }, {
                type: 'g',
                name: 'tchannel.rate-limiting.total-rps-limit',
                value: 1000,
                delta: null,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.service-rps.steve',
                value: null,
                delta: 3,
                time: null
            }, {
                type: 'g',
                name: 'tchannel.rate-limiting.service-rps-limit.steve',
                value: 100,
                delta: null,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.service-rps.bob',
                value: null,
                delta: 2,
                time: null
            }, {
                type: 'g',
                name: 'tchannel.rate-limiting.service-rps-limit.bob',
                value: 100,
                delta: null,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.kill-switch.service-rps.steve',
                value: null,
                delta: 3,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.kill-switch.service-rps.bob',
                value: null,
                delta: 2,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.total-rps',
                value: null,
                delta: 2,
                time: null
            }, {
                type: 'g',
                name: 'tchannel.rate-limiting.total-rps-limit',
                value: 1000,
                delta: null,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.service-rps.steve',
                value: null,
                delta: 1,
                time: null
            }, {
                type: 'g',
                name: 'tchannel.rate-limiting.service-rps-limit.steve',
                value: 100,
                delta: null,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.service-rps.bob',
                value: null,
                delta: 1,
                time: null
            }, {
                type: 'g',
                name: 'tchannel.rate-limiting.service-rps-limit.bob',
                value: 100,
                delta: null,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.kill-switch.service-rps.steve',
                value: null,
                delta: 1,
                time: null
            }, {
                type: 'c',
                name: 'tchannel.rate-limiting.kill-switch.service-rps.bob',
                value: null,
                delta: 1,
                time: null
            }], 'stats keys/values as expected');

            channel.close();
            rateLimiter.destroy();
            assert.end();
        }
    });
});

test('remove counter works', function t(assert) {
    var channel = new TChannel({
        timers: timers
    });
    var rateLimiter = RateLimiter({
        channel: channel,
        numOfBuckets: 2
    });

    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve');

    rateLimiter.removeServiceCounter('steve');
    rateLimiter.removeKillSwitchCounter('steve');

    assert.equals(rateLimiter.totalRequestCounter.rps, 5, 'total request');
    assert.ok(!rateLimiter.serviceCounters.steve, 'steve should be removed');
    assert.ok(!rateLimiter.ksCounters.steve, 'steve should be removed - kill switch');
    assert.equals(rateLimiter.serviceCounters.bob.rps, 2, 'request for bob');

    rateLimiter.destroy();
    channel.close();
    assert.end();
});

test('rate limit works', function t(assert) {
    var channel = new TChannel({
        timers: timers
    });
    var rateLimiter = RateLimiter({
        channel: channel,
        numOfBuckets: 2,
        rpsLimitForServiceName: {
            steve: 2
        },
        totalRpsLimit: 3
    });

    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve');
    increment(rateLimiter, 'steve');
    increment(rateLimiter, 'steve');

    assert.equals(rateLimiter.ksCounters.steve.rpsLimit, 4, 'kill swith limit for steve');
    assert.equals(rateLimiter.ksCounters.bob.rpsLimit, 8, 'kill swith limit for bob');

    assert.equals(rateLimiter.totalRequestCounter.rps, 7, 'total request');
    assert.equals(rateLimiter.serviceCounters.steve.rps, 5, 'request for steve');
    assert.equals(rateLimiter.ksCounters.steve.rps, 5, 'request for steve - kill switch');
    assert.equals(rateLimiter.serviceCounters.bob.rps, 2, 'request for bob');
    assert.equals(rateLimiter.ksCounters.bob.rps, 2, 'request for bob - kill switch');

    assert.ok(rateLimiter.shouldRateLimitTotalRequest(), 'should rate limit total request');
    assert.ok(rateLimiter.shouldRateLimitService('steve'), 'should rate limit steve');
    assert.ok(rateLimiter.shouldKillSwitchService('steve'), 'should kill switch steve');
    assert.ok(!rateLimiter.shouldRateLimitService('bob'), 'should not rate limit bob');
    assert.ok(!rateLimiter.shouldKillSwitchService('bob'), 'should not kill switch bob');

    rateLimiter.destroy();
    channel.close();
    assert.end();
});

test('rate exempt service works 1', function t(assert) {
    var channel = new TChannel({
        timers: timers
    });
    var rateLimiter = RateLimiter({
        channel: channel,
        totalRpsLimit: 2,
        exemptServices: ['steve']
    });

    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');

    assert.ok(!rateLimiter.shouldRateLimitTotalRequest('steve'), 'should not rate limit steve');
    assert.ok(!rateLimiter.shouldRateLimitService('steve'), 'should not rate limit steve');
    assert.ok(!rateLimiter.shouldKillSwitchService('steve'), 'should not kill switch steve');
    assert.ok(rateLimiter.shouldRateLimitTotalRequest('bob'), 'should rate limit bob');

    rateLimiter.destroy();
    channel.close();
    assert.end();
});

test('rate exempt service works 2', function t(assert) {
    var channel = new TChannel({
        timers: timers
    });
    var rateLimiter = RateLimiter({
        channel: channel,
        totalRpsLimit: 2,
        rpsLimitForServiceName: {
            steve: 2,
            bob: 2
        }
    });

    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');
    increment(rateLimiter, 'steve', 'bob');

    assert.equals(rateLimiter.ksCounters.steve.rps, 5, 'steve\'s rps as expected');
    assert.equals(rateLimiter.ksCounters.steve.rpsLimit, 4, 'steve\'s rpsLimit as expected');

    assert.ok(rateLimiter.shouldRateLimitTotalRequest(), 'should rate limit total');
    assert.ok(rateLimiter.shouldKillSwitchService('steve'), 'should kill switch steve');
    assert.ok(rateLimiter.shouldRateLimitService('steve'), 'should rate limit steve');
    assert.ok(rateLimiter.shouldRateLimitService('bob'), 'should rate limit bob');
    assert.ok(rateLimiter.shouldKillSwitchService('bob'), 'should kill switch bob');

    rateLimiter.updateTotalLimit(10);
    rateLimiter.updateServiceLimit('steve', 10);

    assert.equals(rateLimiter.ksCounters.steve.rps, 5, 'steve\'s rps as expected after change of limit');
    assert.equals(rateLimiter.ksCounters.steve.rpsLimit, 15, 'steve\'s rpsLimit as expected after change of limit');

    assert.ok(!rateLimiter.shouldRateLimitTotalRequest(), 'should not rate limit total');
    assert.ok(!rateLimiter.shouldRateLimitService('steve'), 'should not rate limit steve');
    assert.ok(rateLimiter.shouldRateLimitService('bob'), 'should rate limit bob');

    rateLimiter.destroy();
    assert.end();
});
