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

var assert = require('assert');
var http = require('http');
var timers = require('timers');
// TODO use better module. This sometimes fails when you
// move around and change wifi networks.
var myLocalIp = require('my-local-ip');
var os = require('os');
var RingPop = require('ringpop');
var process = require('process');
var uncaught = require('uncaught-exception');
var TChannel = require('tchannel');
var TChannelAsJSON = require('tchannel/as/json');
var CountedReadySignal = require('ready-signal/counted');
var fs = require('fs');
var ProcessReporter = require('process-reporter');
var NullStatsd = require('uber-statsd-client/null');
var extendInto = require('xtend/mutable');
var BatchStatsd = require('tchannel/lib/statsd');

var ServiceProxy = require('../service-proxy.js');
var createLogger = require('./logger.js');
var DualStatsd = require('./dual-statsd.js');
var createRepl = require('./repl.js');
var HeapDumper = require('./heap-dumper.js');
var RemoteConfig = require('./remote-config.js');
var HyperbahnEgressNodes = require('../egress-nodes.js');
var HyperbahnHandler = require('../handler.js');

module.exports = ApplicationClients;

function ApplicationClients(options) {
    /*eslint max-statements: [2, 50] */
    if (!(this instanceof ApplicationClients)) {
        return new ApplicationClients(options);
    }

    var self = this;
    var config = options.config;

    self.lazyTimeout = null;

    // Used in setupRingpop method
    self.ringpopTimeouts = config.get('hyperbahn.ringpop.timeouts');
    self.projectName = config.get('info.project');

    // We need to move away from myLocalIp(); this fails in weird
    // ways when moving around and changing wifi networks.
    // host & port are internal fields since they are just used
    // in bootstrap and are not actually client objects.
    self._host = config.get('tchannel.host') || myLocalIp();
    self._port = options.argv.port;
    self._controlPort = options.argv.controlPort;
    self._bootFile = options.argv.bootstrapFile !== undefined ?
        JSON.parse(options.argv.bootstrapFile) :
        config.get('hyperbahn.ringpop.bootstrapFile');

    var statsOptions = config.get('clients.uber-statsd-client');
    self.statsd = options.seedClients.statsd || (
        (statsOptions && statsOptions.host && statsOptions.port) ?
            DualStatsd({
                host: statsOptions.host,
                port: statsOptions.port,
                project: config.get('info.project'),
                processTitle: options.processTitle
            }) :
            NullStatsd()
    );

    if (options.seedClients.logger) {
        self.logger = options.seedClients.logger;
        self.logReservoir = null;
    } else {
        var loggerParts = createLogger({
            team: config.get('info.team'),
            processTitle: options.processTitle,
            project: config.get('info.project'),
            kafka: config.get('clients.logtron.kafka'),
            logFile: config.get('clients.logtron.logFile'),
            console: config.get('clients.logtron.console'),
            sentry: config.get('clients.logtron.sentry'),
            statsd: self.statsd
        });
        self.logger = loggerParts.logger;
        self.logReservoir = loggerParts.logReservoir;
    }

    /*eslint no-process-env: 0*/
    var uncaughtTimeouts = config.get('clients.uncaught-exception.timeouts');
    self.onError = uncaught({
        logger: self.logger,
        statsd: self.statsd,
        statsdKey: 'uncaught-exception',
        prefix: [
            config.get('info.project'),
            process.env.NODE_ENV,
            os.hostname().split('.')[0]
        ].join('.') + ' ',
        backupFile: config.get('clients.uncaught-exception.file'),
        loggerTimeout: uncaughtTimeouts.loggerTimeout,
        statsdTimeout: uncaughtTimeouts.statsdTimeout,
        statsdWaitPeriod: uncaughtTimeouts.statsdWaitPeriod
    });

    self.processReporter = ProcessReporter({
        statsd: self.statsd
    });

    // This is dead code; really really soon.
    // Need HTTP server or I get fucking paged at 5am
    // Fix the nagios LOL.
    self._controlServer = http.createServer(onRequest);
    function onRequest(req, res) {
        res.end('OK');
    }

    self.batchStats = new BatchStatsd({
        statsd: self.statsd,
        logger: self.logger,
        timers: timers,
        baseTags: {
            app: 'autobahn',
            host: os.hostname()
        }
    });
    self.batchStats.flushStats();

    // Store the tchannel object with its peers on clients
    // Also store a json sender and a raw sender
    self.tchannel = TChannel(extendInto({
        logger: self.logger,
        batchStats: self.batchStats,
        trace: false,
        emitConnectionMetrics: false,
        connectionStalePeriod: 1.5 * 1000,
        useLazyRelaying: false,
        useLazyHandling: false
    }, options.testChannelConfigOverlay));

    self.autobahnHostPortList = self.loadHostList();

    self.tchannelJSON = TChannelAsJSON({
        logger: self.logger
    });
    self.repl = createRepl();

    self.autobahnChannel = self.tchannel.makeSubChannel({
        serviceName: 'autobahn'
    });
    self.ringpopChannel = self.tchannel.makeSubChannel({
        trace: false,
        serviceName: 'ringpop'
    });

    self.egressNodes = HyperbahnEgressNodes({
        defaultKValue: 10
    });

    var hyperbahnTimeouts = config.get('hyperbahn.timeouts');
    self.hyperbahnChannel = self.tchannel.makeSubChannel({
        serviceName: 'hyperbahn',
        trace: false
    });
    self.hyperbahnHandler = HyperbahnHandler({
        channel: self.hyperbahnChannel,
        egressNodes: self.egressNodes,
        callerName: 'autobahn',
        relayAdTimeout: hyperbahnTimeouts.relayAdTimeout
    });
    self.hyperbahnChannel.handler = self.hyperbahnHandler;

    // Circuit health monitor and control
    var circuitsConfig = config.get('hyperbahn.circuits');

    var serviceProxyOpts = {
        channel: self.tchannel,
        logger: self.logger,
        statsd: self.statsd,
        batchStats: self.batchStats,
        egressNodes: self.egressNodes,
        servicePurgePeriod: options.servicePurgePeriod,
        serviceReqDefaults: options.serviceReqDefaults,
        rateLimiterEnabled: false,
        defaultTotalKillSwitchBuffer: options.defaultTotalKillSwitchBuffer,
        rateLimiterBuckets: options.rateLimiterBuckets,
        circuitsConfig: circuitsConfig,
        partialAffinityEnabled: false,
        minPeersPerRelay: options.minPeersPerRelay,
        minPeersPerWorker: options.minPeersPerWorker
    };

    self.serviceProxy = ServiceProxy(serviceProxyOpts);
    self.tchannel.handler = self.serviceProxy;

    self.heapDumper = HeapDumper({
        heapFolder: config.get('clients.heapsnapshot').folder,
        logger: self.logger
    });

    self.remoteConfig = RemoteConfig({
        configFile: config.get('clients.remote-config.file'),
        pollInterval: config.get('clients.remote-config').pollInterval,
        logger: self.logger,
        logError: config.get('clients.remote-config.logError')
    });
    self.remoteConfig.on('update', onRemoteConfigUpdate);
    // initlialize to default
    self.remoteConfig.loadSync();
    self.onRemoteConfigUpdate();
    self.remoteConfig.startPolling();

    function onRemoteConfigUpdate() {
        self.onRemoteConfigUpdate();
    }
}

ApplicationClients.prototype.loadHostList = function loadHostList() {
    var self = this;

    var bootFile = self._bootFile;
    var autobahnHostPortList;

    if (Array.isArray(bootFile)) {
        return bootFile;
    }

    try {
        // load sync because startup
        autobahnHostPortList = JSON.parse(fs.readFileSync(bootFile, 'utf8'));
    } catch (e) {
        return null;
    }

    return autobahnHostPortList;
};

ApplicationClients.prototype.setupChannel =
function setupChannel(cb) {
    var self = this;

    assert(typeof cb === 'function', 'cb required');

    var listenReady = CountedReadySignal(4);
    listenReady(cb);

    self.processReporter.bootstrap();

    self.tchannel.on('listening', listenReady.signal);
    self.tchannel.listen(self._port, self._host);

    self.repl.once('listening', listenReady.signal);
    self.repl.start();

    if (self.logger.bootstrap) {
        self.logger.bootstrap(listenReady.signal);
    } else {
        listenReady.signal();
    }

    self._controlServer.listen(self._controlPort, listenReady.signal);
};

ApplicationClients.prototype.setupRingpop =
function setupRingpop(cb) {
    var self = this;

    self.ringpop = RingPop({
        app: self.projectName,
        hostPort: self.tchannel.hostPort,
        channel: self.ringpopChannel,
        logger: self.logger,
        statsd: self.statsd,
        pingReqTimeout: self.ringpopTimeouts.pingReqTimeout,
        pingTimeout: self.ringpopTimeouts.pingTimeout,
        joinTimeout: self.ringpopTimeouts.joinTimeout
    });
    self.ringpop.setupChannel();

    self.egressNodes.setRingpop(self.ringpop);

    if (self.autobahnHostPortList) {
        self.ringpop.bootstrap(self.autobahnHostPortList, cb);
    } else {
        process.nextTick(cb);
    }
};

ApplicationClients.prototype.bootstrap =
function bootstrap(cb) {
    var self = this;

    self.setupChannel(setupDone);

    function setupDone(err) {
        if (err) {
            cb(err);
        }

        self.setupRingpop(cb);
    }
};

ApplicationClients.prototype.destroy = function destroy() {
    var self = this;

    self.serviceProxy.destroy();
    self.remoteConfig.destroy();
    self.ringpop.destroy();
    if (!self.tchannel.destroyed) {
        self.tchannel.close();
    }
    self.processReporter.destroy();
    self.tchannel.timers.clearTimeout(self.lazyTimeout);
    self.batchStats.destroy();

    self.repl.close();
    self._controlServer.close();

    if (self.logger.destroy) {
        self.logger.destroy();
    }
};

ApplicationClients.prototype.onRemoteConfigUpdate = function onRemoteConfigUpdate() {
    var self = this;
    self.updateWriteBufferMode();
    self.updateLazyHandling();
    self.updateCircuitsEnabled();
    self.updateRateLimitingEnabled();
    self.updateTotalRpsLimit();
    self.updateExemptServices();
    self.updateRpsLimitForServiceName();
    self.updateKValues();
    self.updateKillSwitches();
    self.updateReservoir();
    self.updateReapPeersPeriod();
    self.updatePartialAffinityEnabled();
};

ApplicationClients.prototype.updateWriteBufferMode =
function updateWriteBufferMode() {
    var self = this;
    self.tchannel.setWriteBufferMode(self.remoteConfig.get(
        'write_buffer_mode', 1 // WRITE_BUFFER_STATIC
    ));
};

ApplicationClients.prototype.updateLazyHandling = function updateLazyHandling() {
    var self = this;
    var enabled = self.remoteConfig.get('lazy.handling.enabled', true);
    self.tchannel.setLazyRelaying(enabled);

    self.tchannel.timers.clearTimeout(self.lazyTimeout);

    if (enabled === false) {
        self.tchannel.timers.clearTimeout(self.lazyTimeout);
        self.lazyTimeout = self.tchannel.timers.setTimeout(turnOffLazyHandling, 30000);
    } else {
        self.tchannel.setLazyHandling(enabled);
    }

    function turnOffLazyHandling() {
        self.tchannel.setLazyHandling(enabled);
    }
};

ApplicationClients.prototype.updateReservoir = function updateReservoir() {
    var self = this;
    if (self.logReservoir) {
        var size = self.remoteConfig.get('log.reservoir.size', 100);
        var interval = self.remoteConfig.get('log.reservoir.flushInterval', 50);

        self.logReservoir.setFlushInterval(interval);
        self.logReservoir.setSize(size);
    }
};

ApplicationClients.prototype.updateCircuitsEnabled = function updateCircuitsEnabled() {
    var self = this;
    var enabled = self.remoteConfig.get('circuits.enabled', false);
    if (enabled) {
        self.serviceProxy.enableCircuits();
    } else {
        self.serviceProxy.disableCircuits();
    }
};

ApplicationClients.prototype.updateRateLimitingEnabled = function updateRateLimitingEnabled() {
    var self = this;
    var enabled = self.remoteConfig.get('rateLimiting.enabled', false);
    if (enabled) {
        self.serviceProxy.enableRateLimiter();
    } else {
        self.serviceProxy.disableRateLimiter();
    }
};

ApplicationClients.prototype.updateReapPeersPeriod = function updateReapPeersPeriod() {
    var self = this;
    var period = self.remoteConfig.get('peerReaper.period', 0);
    self.serviceProxy.setReapPeersPeriod(period);
};

ApplicationClients.prototype.updatePartialAffinityEnabled = function updatePartialAffinityEnabled() {
    var self = this;
    var enabled = self.remoteConfig.get('partialAffinity.enabled', false);
    if (enabled) {
        self.serviceProxy.enablePartialAffinity();
    } else {
        self.serviceProxy.disablePartialAffinity();
    }
};

ApplicationClients.prototype.updateTotalRpsLimit = function updateTotalRpsLimit() {
    var self = this;
    var limit = self.remoteConfig.get('rateLimiting.totalRpsLimit', 1200);
    self.serviceProxy.rateLimiter.updateTotalLimit(limit);
};

ApplicationClients.prototype.updateExemptServices = function updateExemptServices() {
    var self = this;
    var exemptServices = self.remoteConfig.get('rateLimiting.exemptServices', ['autobahn', 'ringpop']);
    self.serviceProxy.rateLimiter.updateExemptServices(exemptServices);
};

ApplicationClients.prototype.updateRpsLimitForServiceName = function updateRpsLimitForServiceName() {
    var self = this;
    var rpsLimitForServiceName = self.remoteConfig.get('rateLimiting.rpsLimitForServiceName', {});
    self.serviceProxy.rateLimiter.updateRpsLimitForAllServices(rpsLimitForServiceName);
};

ApplicationClients.prototype.updateKValues = function updateKValues() {
    var self = this;
    var defaultKValue = self.remoteConfig.get('kValue.default', 10);
    self.egressNodes.setDefaultKValue(defaultKValue);

    var serviceKValues = self.remoteConfig.get('kValue.services', {});
    var keys = Object.keys(serviceKValues);
    for (var i = 0; i < keys.length; i++) {
        var serviceName = keys[i];
        var kValue = serviceKValues[serviceName];
        self.egressNodes.setKValueFor(serviceName, kValue);
        self.serviceProxy.updateServiceChannels();
    }
};

ApplicationClients.prototype.updateKillSwitches = function updateKillSwitches() {
    var self = this;
    self.serviceProxy.unblockAllRemoteConfig();
    var killSwitches = self.remoteConfig.get('killSwitch', []);

    for (var i = 0; i < killSwitches.length; i++) {
        var value = killSwitches[i];
        var edge = value.split('~~');
        if (edge.length === 2 && value !== '*~~*') {
            self.serviceProxy.blockRemoteConfig(edge[0], edge[1]);
        }
    }
};
