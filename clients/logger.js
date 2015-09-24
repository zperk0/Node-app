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

var os = require('os');
var Logger = require('logtron');
var process = require('process');

var LarchLogger = require('../lib/larch/larch');
var LogtronBackend = require('../lib/larch/logtron-backend');
var ReservoirBackend = require('../lib/larch/reservoir-backend');
var LevelRouterBackend = require('../lib/larch/level-router-backend');
var DropBackend = require('../lib/larch/drop-backend');

var Levels = {
    TRACE: 10,
    DEBUG: 20,
    INFO: 30,
    ACCESS: 35,
    WARN: 40,
    ERROR: 50,
    FATAL: 60
};

module.exports = createLogger;

// inline createLogger for now because yolo
function createLogger(options) {
    var logtronLogger = new Logger({
        meta: {
            team: options.team,
            project: options.project,
            hostname: os.hostname(),
            pid: process.pid,
            processTitle: options.processTitle
        },
        levels: {
            trace: {
                backends: [],
                level: Levels.TRACE
            },
            debug: {
                backends: ['disk', 'file', 'console'],
                level: Levels.DEBUG
            },
            info: {
                backends: ['disk', 'file', 'kafka', 'console'],
                level: Levels.INFO
            },
            access: {
                backends: ['access'],
                level: Levels.ACCESS
            },
            warn: {
                backends: ['disk', 'file', 'kafka', 'console'],
                level: Levels.WARN
            },
            error: {
                backends: ['disk', 'file', 'kafka', 'console', 'sentry'],
                level: Levels.ERROR
            },
            fatal: {
                backends: ['disk', 'file', 'kafka', 'console', 'sentry'],
                level: Levels.FATAL
            }
        },
        statsd: options.statsd,
        backends: Logger.defaultBackends({
            kafka: options.kafka,
            logFile: options.logFile,
            console: options.console,
            sentry: options.sentry,
            raw: true,
            json: true
        }, {
            statsd: options.statsd
        }),
        transforms: []
    });

    var reservoir = ReservoirBackend({
        backend: LogtronBackend(logtronLogger),
        statsd: options.statsd
    });

    // debug logs sent to drop backend; rest of logs are reservoir sampled
    // then sent to Logtron
    var levelRouterBackend = LevelRouterBackend({
        backends: {
            debug: DropBackend(),
            default: reservoir
        }
    });

    var logger = LarchLogger({
        backends: [levelRouterBackend],
        statsd: options.statsd
    });

    return {
        logger: logger,
        reservoir: reservoir
    };
}
