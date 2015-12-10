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

/* eslint-disable max-statements */

var assert = require('assert');
var Buffer = require('buffer').Buffer;
var RelayHandler = require('tchannel/relay_handler');
var EventEmitter = require('tchannel/lib/event_emitter');
var clean = require('tchannel/lib/statsd').clean;
var util = require('util');
var setImmediate = require('timers').setImmediate;

var IntervalScan = require('./lib/interval-scan.js');
var RateLimiter = require('./rate_limiter.js');
var PartialRange = require('./partial_range.js');
var Circuits = require('./circuits.js');

var DEFAULT_LOG_GRACE_PERIOD = 5 * 60 * 1000;
var SERVICE_PURGE_PERIOD = 5 * 60 * 1000;
var DEFAULT_MIN_PEERS_PER_WORKER = 5;
var DEFAULT_MIN_PEERS_PER_RELAY = 5;
var DEFAULT_STATS_PERIOD = 30 * 1000; // every 30 seconds
var DEFAULT_REAP_PEERS_PERIOD = 5 * 60 * 1000; // every 5 minutes
var DEFAULT_PRUNE_PEERS_PERIOD = 2 * 60 * 1000; // every 2 minutes

// our call SLA is 30 seconds currently
var DEFAULT_DRAIN_TIMEOUT = 30 * 1000;

var RATE_LIMIT_TOTAL = 'total';
var RATE_LIMIT_SERVICE = 'service';
var RATE_LIMIT_KILLSWITCH = 'killswitch';

var CN_HEADER_BUFFER = new Buffer('cn');
var RD_HEADER_BUFFER = new Buffer('rd');

function ServiceDispatchHandler(options) {
    if (!(this instanceof ServiceDispatchHandler)) {
        return new ServiceDispatchHandler(options);
    }
    var self = this;

    EventEmitter.call(self);
    self.roleTransitionEvent = self.defineEvent('roleTransition');

    assert(options, 'service dispatch handler options not actually optional');
    self.channel = options.channel;
    self.logger = options.logger || self.channel.logger;
    self.batchStats = options.batchStats;
    self.statsd = options.statsd;
    self.egressNodes = options.egressNodes;
    self.createdAt = self.channel.timers.now();
    self.logGracePeriod = options.logGracePeriod ||
        DEFAULT_LOG_GRACE_PERIOD;
    self.permissionsCache = options.permissionsCache;
    self.serviceReqDefaults = options.serviceReqDefaults || {};

    self.circuitsEnabled = false;
    self.circuitsConfig = options.circuitsConfig;
    self.circuits = null;
    self.boundOnCircuitStateChange = onCircuitStateChange;

    self.rateLimiter = new RateLimiter({
        channel: self.channel,
        batchStats: self.batchStats,
        rpsLimitForServiceName: options.rpsLimitForServiceName,
        exemptServices: options.exemptServices,
        totalRpsLimit: options.totalRpsLimit,
        defaultServiceRpsLimit: options.defaultServiceRpsLimit,
        defaultTotalKillSwitchBuffer: options.defaultTotalKillSwitchBuffer,
        numOfBuckets: options.rateLimiterBuckets
    });
    self.rateLimiterEnabled = options.rateLimiterEnabled;

    self.partialAffinityEnabled = !!options.partialAffinityEnabled;
    self.minPeersPerWorker = options.minPeersPerWorker || DEFAULT_MIN_PEERS_PER_WORKER;
    self.minPeersPerRelay = options.minPeersPerRelay || DEFAULT_MIN_PEERS_PER_RELAY;
    self.drainTimeout = options.drainTimeout || DEFAULT_DRAIN_TIMEOUT;

    /* service peer state data structures
     *
     * serviceName           :: string
     * hostPort              :: string
     * lastRefresh           :: number // timestamp
     * relaysFor             :: Map<serviceName, List<hostPort>>
     * partialRanges         :: Map<serviceName, PartialRange>
     * exitServices          :: Map<serviceName, lastRefresh>
     * peersToReap           :: Map<hostPort, lastRefresh>
     * knownPeers            :: Map<hostPort, lastRefresh>
     * connectedServicePeers :: Map<serviceName, Map<hostPort, lastRefresh>>
     * connectedPeerServices :: Map<hostPort, Map<serviceName, lastRefresh>>
     *
     * PartialRange    :: {
     *   relayHostPort :: hostPort,        // the host port of this relay
     *   relays        :: Array<hostPort>, // sorted
     *   workers       :: Array<hostPort>, // sorted
     *   relayIndex    :: Integer,         // the index of relayHostPort in relays
     *   ratio         :: Float,           // the conversion ratio for relays to workers
     *   length        :: Integer,         // the size of the subset
     *   start         :: Integer,         // the start index of the subset
     *   stop          :: Integer,         // the stop index of the subset
     *   affineWorkers :: ?Array<hostPort> // the computed subset of workers
     * }
     *
     * connectedServicePeers and connectedPeerServices are updated by
     * connection events, maybe subject to partial affinity.
     *
     * On every advertise knownPeers is updated.
     *
     * However every reap period, knownPeers gets rolled over into peersToReap
     * and emptied, so it represents the "peers seen this reap round"
     */
    self.relaysFor = Object.create(null);
    self.partialRanges = Object.create(null);
    self.exitServices = Object.create(null);
    self.connectedServicePeers = Object.create(null);
    self.connectedPeerServices = Object.create(null);
    self.peersToReap = Object.create(null);
    self.knownPeers = Object.create(null);
    self.peersToPrune = Object.create(null);

    self.peerPruner = new IntervalScan({
        name: 'peer-prune',
        timers: self.channel.timers,
        interval: options.prunePeersPeriod || DEFAULT_PRUNE_PEERS_PERIOD,
        each: function pruneEachPeer(hostPort, pruneInfo) {
            self.pruneSinglePeer(hostPort, pruneInfo);
        },
        getCollection: function getPeersToPrune() {
            var peersToPrune = self.peersToPrune;
            self.peersToPrune = Object.create(null);
            return peersToPrune;
        }
    });
    self.peerPruner.runBeginEvent.on(function onPeerReapBegin(run) {
        if (run.keys.length) {
            self.logger.info(
                'pruning peers',
                self.extendLogInfo({
                    numPeersToPrune: run.keys.length
                })
            );
        }
    });
    self.peerPruner.start();

    // Populated by remote-config
    self.peerHeapEnabledServices = Object.create(null);
    self.peerHeapEnabledGlobal = false;

    self.peerReaper = new IntervalScan({
        name: 'peer-reap',
        timers: self.channel.timers,
        interval: options.reapPeersPeriod || DEFAULT_REAP_PEERS_PERIOD,
        each: function reapSinglePeer(hostPort, serviceNames, now) {
            self.reapSinglePeer(hostPort, serviceNames, now);
        },
        getCollection: function getPeersToReap() {
            var peersToReap = self.peersToReap;
            self.peersToReap = self.knownPeers;
            self.knownPeers = Object.create(null);
            return peersToReap;
        }
    });
    self.peerReaper.runBeginEvent.on(function onPeerReapBegin(run) {
        if (run.keys.length) {
            self.logger.info(
                'reaping dead peers',
                self.extendLogInfo({
                    numPeersToReap: run.keys.length
                })
            );
        }
    });
    self.peerReaper.start();

    self.servicePurger = new IntervalScan({
        name: 'service-purge',
        timers: self.channel.timers,
        interval: options.servicePurgePeriod || SERVICE_PURGE_PERIOD,
        each: function maybePurgeEachService(serviceName, lastRefresh) {
            var now = self.channel.timers.now();
            if (now - lastRefresh > self.servicePurgePeriod) {
                delete self.exitServices[serviceName];
                var serviceChannel = self.channel.subChannels[serviceName];
                if (serviceChannel) {
                    serviceChannel.close();
                    delete self.channel.subChannels[serviceName];
                    self.rateLimiter.removeServiceCounter(serviceName);
                    self.rateLimiter.removeKillSwitchCounter(serviceName);
                }
            }
        },
        getCollection: function getExitServices() {
            return self.exitServices;
        }
    });
    self.servicePurger.start();

    self.statEmitter = new IntervalScan({
        name: 'channel-stat-emit',
        timers: self.channel.timers,
        interval: options.statsPeriod || DEFAULT_STATS_PERIOD,
        each: function emitEachSubChannelStats(serviceName, serviceChannel) {
            // TODO: only if it's a service channel (relay handler, maybe check
            // for exit mode?)
            self.emitPeriodicServiceStats(serviceChannel, serviceName);
        },
        getCollection: function getSubChannels() {
            return self.channel.subChannels;
        }
    });
    self.statEmitter.start();

    self.destroyed = false;

    self.egressNodes.changedEvent.on(onEgressNodesChanged);

    if (self.circuitsConfig && self.circuitsConfig.enabled) {
        self.enableCircuits();
    }

    function onCircuitStateChange(stateChange) {
        self.onCircuitStateChange(stateChange);
    }

    function onEgressNodesChanged() {
        setImmediate(updateServiceChannels);
    }

    function updateServiceChannels() {
        self.updateServiceChannels();
    }
}

util.inherits(ServiceDispatchHandler, EventEmitter);

ServiceDispatchHandler.prototype.type = 'tchannel.hyperbahn.service-dispatch-handler';

ServiceDispatchHandler.prototype.handleLazily =
function handleLazily(conn, reqFrame) {
    var self = this;

    /*eslint max-statements: [2, 45]*/
    /*eslint complexity: [2, 17]*/

    var res = reqFrame.bodyRW.lazy.readService(reqFrame);
    if (res.err) {
        // TODO: stat?
        self.channel.logger.error(
            'failed to lazy read frame serviceName',
            conn.extendLogInfo({
                error: res.err
            })
        );
        // TODO: protocol error instead?
        conn.sendLazyErrorFrameForReq(reqFrame, 'BadRequest', 'failed to read serviceName');
        return false;
    }

    var serviceName = res.value;
    if (!serviceName) {
        // TODO: reqFrame.extendLogInfo would be nice, especially if it added
        // things like callerName and arg1
        self.channel.logger.error(
            'missing service name in lazy frame',
            conn.extendLogInfo({})
        );
        conn.sendLazyErrorFrameForReq(reqFrame, 'BadRequest', 'missing serviceName');
        return false;
    }

    // TODO: feature support
    // - blocking
    // - rate limiting

    res = reqFrame.bodyRW.lazy.readHeaders(reqFrame);
    if (res.err) {
        // TODO: stat?
        self.channel.logger.warn(
            'failed to lazy read frame headers',
            conn.extendLogInfo({
                error: res.err
            })
        );
        // TODO: protocol error instead?
        conn.sendLazyErrorFrameForReq(reqFrame, 'BadRequest', 'failed to read headers');
        return false;
    }

    var rdBuf = res.value && res.value.getValue(RD_HEADER_BUFFER);
    var routingDelegate = rdBuf && rdBuf.toString();

    var nextService = routingDelegate || serviceName;

    var cnBuf = res.value && res.value.getValue(CN_HEADER_BUFFER);
    var cn = cnBuf && cnBuf.toString();
    if (!cn) {
        self.channel.logger.warn(
            'request missing cn header',
            conn.extendLogInfo({
                serviceName: serviceName
            })
        );
        conn.sendLazyErrorFrameForReq(reqFrame, 'BadRequest', 'missing cn header');
        return false;
    }

    if (self.isBlocked(cn, serviceName)) {
        conn.ops.popInReq(reqFrame.id);
        return null;
    }

    if (self.rateLimiterEnabled) {
        var rateLimitReason = self.rateLimit(cn, nextService);

        if (rateLimitReason === RATE_LIMIT_KILLSWITCH) {
            conn.ops.popInReq(reqFrame.id);
            return true;
        } else if (rateLimitReason === RATE_LIMIT_TOTAL) {
            var totalLimit = self.rateLimiter.totalRequestCounter.rpsLimit;
            self.logger.info(
                'hyperbahn node is rate-limited by the total rps limit',
                self.extendLogInfo(conn.extendLogInfo({
                    rpsLimit: totalLimit,
                    serviceCounters: self.rateLimiter.serviceCounters,
                    edgeCounters: self.rateLimiter.edgeCounters
                }))
            );
            conn.sendLazyErrorFrameForReq(reqFrame, 'Busy', 'hyperbahn node is rate-limited by the total rps of ' + totalLimit);
            return true;
        } else if (rateLimitReason === RATE_LIMIT_SERVICE) {
            var serviceLimit = self.rateLimiter.getRpsLimitForService(nextService);
            self.logger.info(
                'hyperbahn service is rate-limited by the service rps limit',
                self.extendLogInfo(conn.extendLogInfo({
                    rpsLimit: serviceLimit,
                    serviceCounters: self.rateLimiter.serviceCounters,
                    edgeCounters: self.rateLimiter.edgeCounters
                }))
            );
            if (routingDelegate) {
                conn.sendLazyErrorFrameForReq(reqFrame, 'Busy', 'Routing delegate ' + routingDelegate + ' is rate-limited by the service rps of ' + serviceLimit);
            } else {
                conn.sendLazyErrorFrameForReq(reqFrame, 'Busy', serviceName + ' is rate-limited by the service rps of ' + serviceLimit);
            }
            return true;
        }
    }

    // use the rd (routing delegate) or the serviceName if there was no rd set
    var serviceChannel = self.channel.subChannels[nextService];
    if (!serviceChannel) {
        serviceChannel = self.createServiceChannel(nextService);
    }

    if (serviceChannel.handler.handleLazily) {
        return serviceChannel.handler.handleLazily(conn, reqFrame);
    } else {
        return false;
    }
};

ServiceDispatchHandler.prototype.handleRequest =
function handleRequest(req, buildRes) {
    var self = this;

    if (!req.serviceName) {
        self.logger.warn(
            'Got incoming req with no service',
            self.extendLogInfo(req.extendLogInfo({}))
        );

        buildRes().sendError('BadRequest', 'no service name given');
        return;
    }

    var routingDelegate = req.headers && req.headers.rd;
    var nextService = routingDelegate || req.serviceName;

    if (self.isBlocked(req.headers && req.headers.cn, nextService)) {
        req.operations.popInReq(req.id);
        return;
    }

    if (self.rateLimiterEnabled) {
        var rateLimitReason = self.rateLimit(req.headers && req.headers.cn, nextService);
        if (rateLimitReason === RATE_LIMIT_KILLSWITCH) {
            if (req.connection &&
                req.connection.ops) {
                req.connection.ops.popInReq(req.id);
            } else {
                // TODO: needed because TChannelSelfConnection, we can drop
                // this once self connection is dead
                self.logger.warn(
                    'rate limiter unable to pop in req, because self connection',
                    self.extendLogInfo(req.extendLogInfo({
                        rateLimitReason: RATE_LIMIT_KILLSWITCH
                    }))
                );
            }
            return;
        } else if (rateLimitReason === RATE_LIMIT_TOTAL) {
            var totalLimit = self.rateLimiter.totalRequestCounter.rpsLimit;
            self.logger.info(
                'hyperbahn node is rate-limited by the total rps limit',
                self.extendLogInfo(req.extendLogInfo({
                    rpsLimit: totalLimit,
                    serviceCounters: self.rateLimiter.serviceCounters,
                    edgeCounters: self.rateLimiter.edgeCounters
                }))
            );
            buildRes().sendError('Busy', 'hyperbahn node is rate-limited by the total rps of ' + totalLimit);
            return;
        } else if (rateLimitReason === RATE_LIMIT_SERVICE) {
            var serviceLimit = self.rateLimiter.getRpsLimitForService(nextService);
            self.logger.info(
                'hyperbahn service is rate-limited by the service rps limit',
                self.extendLogInfo(req.extendLogInfo({
                    rpsLimit: serviceLimit,
                    serviceCounters: self.rateLimiter.serviceCounters,
                    edgeCounters: self.rateLimiter.edgeCounters
                }))
            );
            if (routingDelegate) {
                buildRes().sendError('Busy', 'Routing delegate ' + routingDelegate + ' is rate-limited by the service rps of ' + serviceLimit);
            } else {
                buildRes().sendError('Busy', req.serviceName + ' is rate-limited by the service rps of ' + serviceLimit);
            }
            return;
        }
    }

    var serviceChannel = self.channel.subChannels[nextService];
    if (!serviceChannel) {
        serviceChannel = self.createServiceChannel(nextService);
    }

    // Temporary hack. Need to set json by default because
    // we want to upgrade without breaking ncar
    serviceChannel.handler.handleRequest(req, buildRes);
};

ServiceDispatchHandler.prototype.rateLimit =
function rateLimit(cn, serviceName) {
    var self = this;

    // stats edge traffic
    self.rateLimiter.incrementEdgeCounter(cn + '~~' + serviceName);

    var isExitNode = self.isExitFor(serviceName);
    if (isExitNode) {
        self.rateLimiter.createServiceCounter(serviceName);
        self.rateLimiter.createKillSwitchServiceCounter(serviceName);
    }

    // apply kill switch safe guard first
    if (self.rateLimiter.shouldKillSwitchTotalRequest(serviceName) ||
        (isExitNode && self.rateLimiter.shouldKillSwitchService(serviceName))) {
        return RATE_LIMIT_KILLSWITCH;
    }

    self.rateLimiter.incrementKillSwitchTotalCounter(serviceName);
    if (isExitNode) {
        self.rateLimiter.incrementKillSwitchServiceCounter(serviceName);
    }

    // apply rate limiter
    if (self.rateLimiter.shouldRateLimitTotalRequest(serviceName)) {
        return RATE_LIMIT_TOTAL;
    }

    // check RPS for service limit
    if (isExitNode && self.rateLimiter.shouldRateLimitService(serviceName)) {
        return RATE_LIMIT_SERVICE;
    }

    // increment the counters
    self.rateLimiter.incrementTotalCounter(serviceName);
    if (isExitNode) {
        self.rateLimiter.incrementServiceCounter(serviceName);
    }

    return '';
};

ServiceDispatchHandler.prototype.getOrCreateServiceChannel =
function getOrCreateServiceChannel(serviceName) {
    var self = this;
    return self.getServiceChannel(serviceName, true);
};

ServiceDispatchHandler.prototype.getServiceChannel =
function getServiceChannel(serviceName, create) {
    var self = this;
    var serviceChannel = self.channel.subChannels[serviceName];
    if (!serviceChannel && create) {
        serviceChannel = self.createServiceChannel(serviceName);
    }
    return serviceChannel;
};

ServiceDispatchHandler.prototype.getServicePeer =
function getServicePeer(serviceName, hostPort) {
    var self = this;
    var serviceChannel = self.getOrCreateServiceChannel(serviceName);
    return self._getServicePeer(serviceChannel, hostPort);
};

ServiceDispatchHandler.prototype._getServicePeer =
function _getServicePeer(serviceChannel, hostPort) {
    var peer = serviceChannel.peers.get(hostPort);
    if (!peer) {
        peer = serviceChannel.peers.add(hostPort);
    }
    if (!peer.serviceProxyServices) {
        peer.serviceProxyServices = {};
    }
    peer.serviceProxyServices[serviceChannel.serviceName] = true;
    return peer;
};

ServiceDispatchHandler.prototype.createServiceChannel =
function createServiceChannel(serviceName) {
    var self = this;

    var now = self.channel.timers.now();
    if (now >= self.createdAt + self.logGracePeriod) {
        self.logger.info(
            'Creating new sub channel',
            self.extendLogInfo({
                serviceName: serviceName
            })
        );
    }

    var exitNames = self.relaysFor[serviceName];
    if (!exitNames) {
        var exitNodes = self.egressNodes.exitsFor(serviceName);
        exitNames = Object.keys(exitNodes).sort();
        self.relaysFor[serviceName] = exitNames;
    }

    var isExit = self.egressNodes.isExitFor(serviceName);
    var mode = isExit ? 'exit' : 'forward';

    var choosePeerWithHeap = self.peerHeapEnabledGlobal;
    if (serviceName in self.peerHeapEnabledServices) {
        choosePeerWithHeap = self.peerHeapEnabledServices[serviceName];
    }

    var options = {
        serviceName: serviceName,
        choosePeerWithHeap: choosePeerWithHeap
    };

    if (self.serviceReqDefaults[serviceName]) {
        options.requestDefaults = self.serviceReqDefaults[serviceName];
    }

    if (mode === 'exit') {
        options.preferConnectionDirection = 'out';
    }

    var serviceChannel = self.channel.makeSubChannel(options);
    serviceChannel.serviceProxyMode = mode; // duck: punched

    if (mode === 'forward') {
        for (var i = 0; i < exitNames.length; i++) {
            self._getServicePeer(serviceChannel, exitNames[i]);
        }
    }

    serviceChannel.handler = new RelayHandler(
        serviceChannel,
        mode === 'exit' && self.circuitsEnabled && self.circuits);

    return serviceChannel;
};

ServiceDispatchHandler.prototype.refreshServicePeer =
function refreshServicePeer(serviceName, hostPort) {
    var self = this;

    var serviceChannel = self.getOrCreateServiceChannel(serviceName);
    if (serviceChannel.serviceProxyMode !== 'exit') {
        // TODO: stat, log
        return;
    }

    var now = self.channel.timers.now();

    // Reset the expiration time for this service peer
    self.exitServices[serviceName] = now;

    // -- The new way: partially connect egress nodes to ranges of service peers.
    if (self.partialAffinityEnabled) {
        self.refreshServicePeerPartially(serviceName, hostPort, now);
        return;
    }

    // -- The old way: fully connect every egress to all affine peers.

    // cancel any prune
    delete self.peersToPrune[hostPort];

    // Unmark recently seen peers, so they don't get reaped
    deleteIndexEntry(self.peersToReap, hostPort, serviceName);
    // Mark known peers, so they are candidates for future reaping
    addIndexEntry(self.knownPeers, hostPort, serviceName, now);

    var peer = self.getServicePeer(serviceName, hostPort);
    self.ensurePeerConnected(serviceName, peer, 'service peer refresh', now);
};

ServiceDispatchHandler.prototype.deletePeerIndex =
function deletePeerIndex(serviceName, hostPort) {
    var self = this;

    if (self.partialAffinityEnabled) {
        deleteIndexEntry(self.connectedServicePeers, serviceName, hostPort);
        deleteIndexEntry(self.connectedPeerServices, hostPort, serviceName);
    }
    deleteIndexEntry(self.knownPeers, hostPort, serviceName);
};

ServiceDispatchHandler.prototype.ensurePeerConnected =
function ensurePeerConnected(serviceName, peer, reason, now) {
    var self = this;

    if (self.partialAffinityEnabled) {
        addIndexEntry(self.connectedServicePeers, serviceName, peer.hostPort, now);
        addIndexEntry(self.connectedPeerServices, peer.hostPort, serviceName, now);
    }
    delete self.peersToPrune[peer.hostPort];

    if (peer.isConnected('out')) {
        return;
    }

    if (peer.draining) {
        self.logger.info(
            'canceling peer drain',
            self.extendLogInfo(
                peer.extendLogInfo(peer.draining.extendLogInfo({}))
            )
        );
        peer.clearDrain('canceled to ensure peer connection');
    }

    peer.connectTo();
};

ServiceDispatchHandler.prototype.getPartialRange =
function getPartialRange(serviceName, reason, now) {
    var self = this;

    var partialRange = self.partialRanges[serviceName];
    if (!partialRange) {
        var serviceChannel = self.getOrCreateServiceChannel(serviceName);
        var relays = self.relaysFor[serviceName];
        var workers = serviceChannel.peers.keys().sort();
        partialRange = new PartialRange(
            self.channel.hostPort,
            self.minPeersPerWorker,
            self.minPeersPerRelay
        );
        self.partialRanges[serviceName] = partialRange;
        partialRange.compute(relays, workers, now);
    }

    if (!partialRange.isValid()) {
        // This should only occur if an advertisement loses the race with a
        // relay ring membership change.
        self.logger.warn(
            'Relay could not find itself in the affinity set for service',
            self.extendLogInfo(partialRange.extendLogInfo({
                serviceName: serviceName,
                reason: reason
            }))
        );
        // TODO: upgrade two-in-a-row or more to an error
        return null;
    }

    return partialRange;
};

ServiceDispatchHandler.prototype.refreshServicePeerPartially =
function refreshServicePeerPartially(serviceName, hostPort, now) {
    var self = this;

    // guaranteed non-null by refreshServicePeer above; we call this only so
    // as not to pass another arg along to the partial path.
    var serviceChannel = self.getServiceChannel(serviceName, false);
    var peer = serviceChannel.peers.get(hostPort);

    // simply freshen if not new
    if (peer) {
        self.freshenPartialPeer(peer, serviceName, now);
        return;
    }

    var partialRange = self.partialRanges[serviceName];
    if (partialRange) {
        partialRange.addWorker(hostPort, now);
    }

    peer = self._getServicePeer(serviceChannel, hostPort);

    // Unmark recently seen peers, so they don't get reaped
    deleteIndexEntry(self.peersToReap, hostPort, serviceName);
    // Mark known peers, so they are candidates for future reaping
    addIndexEntry(self.knownPeers, hostPort, serviceName, now);

    var result = self.ensurePartialConnections(
        serviceChannel, serviceName, hostPort,
        'advertise', now);

    if (result && result.noop) {
        // if ensurePartialConnections did no work, we need to freshen the
        // secondary indices since neither ensurePeerConnected nor
        // ensurePeerDisconnected were called for the advertising peer
        if (result.isAffine[hostPort]) {
            addIndexEntry(self.connectedServicePeers, serviceName, hostPort, now);
            addIndexEntry(self.connectedPeerServices, hostPort, serviceName, now);
            delete self.peersToPrune[hostPort];
        } else {
            deleteIndexEntry(self.connectedServicePeers, serviceName, hostPort);
            deleteIndexEntry(self.connectedPeerServices, hostPort, serviceName);
        }
    }
};

ServiceDispatchHandler.prototype.freshenPartialPeer =
function freshenPartialPeer(peer, serviceName, now) {
    var self = this;

    var hostPort = peer.hostPort;
    var connectedPeers = self.connectedServicePeers[serviceName];
    var connected = connectedPeers && connectedPeers[hostPort];

    // Update secondary indices
    if (connected) {
        addIndexEntry(self.connectedServicePeers, serviceName, peer.hostPort, now);
        addIndexEntry(self.connectedPeerServices, hostPort, serviceName, now);
        delete self.peersToPrune[hostPort];
    } else {
        deleteIndexEntry(self.connectedServicePeers, serviceName, peer.hostPort);
        deleteIndexEntry(self.connectedPeerServices, hostPort, serviceName);
    }

    // Unmark recently seen peers, so they don't get reaped
    deleteIndexEntry(self.peersToReap, peer.hostPort, serviceName);
    // Mark known peers, so they are candidates for future reaping
    addIndexEntry(self.knownPeers, peer.hostPort, serviceName, now);

    // TODO: this audit shouldn't be necessary once we understand and fix
    // why it was needed in the first place
    var partialRange = self.getPartialRange(serviceName, 'refresh partial peer audit', now);
    if (partialRange) {
        var shouldConnect = partialRange.affineWorkers.indexOf(hostPort) >= 0;
        var isConnected = !!connected;
        if (isConnected !== shouldConnect) {
            self.logger.warn(
                'partial affinity audit fail',
                self.extendLogInfo(partialRange.extendLogInfo({
                    path: 'freshenPartialPeer',
                    serviceName: serviceName,
                    serviceHostPort: hostPort,
                    isConnected: isConnected,
                    shouldConnect: shouldConnect
                }))
            );
            if (shouldConnect) {
                connected = now;
            } else {
                connected = null;
            }
        }
    }

    if (connected) {
        self.ensurePeerConnected(serviceName, peer, 'service peer affinity refresh', now);
    } else {
        self.ensurePeerDisconnected(serviceName, peer, 'service peer affinity refresh', now);
    }
};

ServiceDispatchHandler.prototype.ensurePartialConnections =
function ensurePartialConnections(serviceChannel, serviceName, hostPort, reason, now) {
    var self = this;

    var partialRange = self.getPartialRange(serviceName, reason, now);
    if (!partialRange) {
        return null;
    }

    if (!partialRange.affineWorkers.length) {
        self.logger.warn(
            'empty affine workers list',
            self.extendLogInfo(partialRange.extendLogInfo({
                serviceName: serviceName,
                reason: reason
            }))
        );
        // TODO: why not return early
    }

    var connectedPeers = self.connectedServicePeers[serviceName];
    var connectedPeerKeys = connectedPeers ? Object.keys(connectedPeers) : [];
    var toConnect = [];
    var toDisconnect = [];
    var isAffine = {};
    var i;
    var worker;
    var peer;
    var result = {
        noop: false,
        toConnect: toConnect,
        isAffine: isAffine
    };
    for (i = 0; i < partialRange.affineWorkers.length; i++) {
        worker = partialRange.affineWorkers[i];
        peer = self._getServicePeer(serviceChannel, worker);
        isAffine[worker] = true;
        toConnect.push(worker);

        if (connectedPeers && connectedPeers[worker] && !peer.isConnected('out')) {
            // NOTE: this happens because we have no low-level goal states for
            // being connected to a peer; the advertise signal is the only way
            // we pump ensurePartialConnections.

            // TODO: this audit shouldn't be necessary once we understand and fix
            // why it was needed in the first place
            self.logger.warn(
                'partial affinity audit fail',
                self.extendLogInfo(partialRange.extendLogInfo({
                    path: 'ensurePartialConnections: ' + reason,
                    serviceHostPort: worker,
                    serviceName: serviceName,
                    isConnected: false,
                    shouldConnect: true
                }))
            );
        }
    }

    for (i = 0; i < connectedPeerKeys.length; i++) {
        worker = connectedPeerKeys[i];
        if (!isAffine[worker] && !self.peersToPrune[worker]) {
            toDisconnect.push(worker);
        }
    }

    if (!toConnect.length && !toDisconnect.length) {
        result.noop = true;
        return result;
    }

    self.logger.info(
        'implementing affinity change',
        self.extendLogInfo(partialRange.extendLogInfo({
            serviceName: serviceName,
            reason: reason,
            toConnect: toConnect,
            toDisconnect: toDisconnect
        }))
    );

    for (i = 0; i < toConnect.length; i++) {
        peer = self._getServicePeer(serviceChannel, toConnect[i]);
        self.ensurePeerConnected(serviceName, peer, 'service peer affinity change', now);
    }

    for (i = 0; i < toDisconnect.length; i++) {
        peer = self._getServicePeer(serviceChannel, toDisconnect[i]);
        self.ensurePeerDisconnected(serviceName, peer, 'service peer affinity change', now);
    }
    return result;
};

ServiceDispatchHandler.prototype.ensurePeerDisconnected =
function ensurePeerDisconnected(serviceName, peer, reason, now) {
    var self = this;

    if (self.partialAffinityEnabled) {
        deleteIndexEntry(self.connectedServicePeers, serviceName, peer.hostPort);
        deleteIndexEntry(self.connectedPeerServices, peer.hostPort, serviceName);
    }

    var peerServices = self.connectedPeerServices[peer.hostPort];
    if (!peerServices || isObjectEmpty(peerServices)) {
        self.peersToPrune[peer.hostPort] = {
            lastRefresh: now,
            reason: reason
        };
    }
};

ServiceDispatchHandler.prototype.removeServicePeer =
function removeServicePeer(serviceName, hostPort) {
    var self = this;
    var now = self.channel.timers.now();

    var serviceChannel = self.channel.subChannels[serviceName];
    if (!serviceChannel) {
        return;
    }

    var peer = self.channel.peers.get(hostPort);
    if (!peer) {
        return;
    }
    serviceChannel.peers.delete(hostPort);

    if (self.partialAffinityEnabled) {
        var partialRange = self.partialRanges[serviceName];
        if (partialRange) {
            // TODO: would be better to do an incremental update:
            // - remove (if exists)
            // - recompute if any was removed
            var workers = serviceChannel.peers.keys().sort();
            partialRange.compute(null, workers, now);
        }

        var result = self.ensurePartialConnections(
            serviceChannel, serviceName, hostPort,
            'unadvertise', now);
        if (result && result.noop) {
            // if ensurePartialConnections did no work, we need to celar the
            // secondary indices since neither ensurePeerDisconnected was called
            // for the unadvertising peer
            deleteIndexEntry(self.connectedServicePeers, serviceName, hostPort);
            deleteIndexEntry(self.connectedPeerServices, hostPort, serviceName);
        }
    }

    var subChanKeys = Object.keys(self.channel.subChannels);
    var remain = [];
    for (var i = 0; i < subChanKeys; i++) {
        var subChan = self.channel.subChannels[subChanKeys[i]];
        if (subChan.peers.get(hostPort)) {
            remain.push(subChanKeys[i]);
        }
    }

    if (remain.length) {
        self.logger.info(
            'not removing unadvertised peer due to remaining services',
            self.extendLogInfo(peer.extendLogInfo({
                unadvertisedService: serviceName,
                remainingServices: remain
            }))
        );
        return;
    }

    if (peer.draining) {
        if (peer.draining.reason.indexOf('reaped') === 0) {
            self.logger.info(
                'skipping unadvertisement drain due to ongoing reap',
                self.extendLogInfo(
                    peer.extendLogInfo(peer.draining.extendLogInfo({}))
                )
            );
            return;
        }
        self.logger.warn(
            'canceling peer drain to implement for unadvertisement drain',
            self.extendLogInfo(
                peer.extendLogInfo(peer.draining.extendLogInfo({}))
            )
        );
        peer.clearDrain();
    }

    peer.drain({
        goal: peer.DRAIN_GOAL_CLOSE_PEER,
        reason: 'closing due to unadvertisement',
        direction: 'both',
        timeout: self.drainTimeout
    }, thenDeleteIt);

    function thenDeleteIt(err) {
        if (err) {
            self.logger.warn(
                'error closing unadvertised peer, deleting it anyhow',
                self.extendLogInfo(
                    peer.extendLogInfo(peer.draining.extendLogInfo({
                        error: err
                    }))
                )
            );
        }

        self.logger.info(
            'Peer drained and closed due to unadvertisement',
            peer.extendLogInfo({
                serviceName: serviceName
            })
        );
        self.channel.peers.delete(hostPort);
    }
};

ServiceDispatchHandler.prototype.updateServiceChannels =
function updateServiceChannels() {
    var self = this;

    var now = self.channel.timers.now();
    var serviceNames = Object.keys(self.channel.subChannels);
    for (var i = 0; i < serviceNames.length; i++) {
        var serviceName = serviceNames[i];
        var serviceChannel = self.channel.subChannels[serviceName];
        if (serviceChannel.serviceProxyMode) {
            self.updateServiceChannel(serviceChannel, now);
        }
    }

    if (self.circuits) {
        self.circuits.updateServices();
    }
};

ServiceDispatchHandler.prototype.updateServiceChannel =
function updateServiceChannel(serviceChannel, now) {
    var self = this;

    // TODO: would be nice to do a more incremental update
    var exitNodes = self.egressNodes.exitsFor(serviceChannel.serviceName);
    self.relaysFor[serviceChannel.serviceName] = Object.keys(exitNodes).sort();

    if (self.egressNodes.isExitFor(serviceChannel.serviceName)) {
        if (self.partialAffinityEnabled) {
            var partialRange = self.partialRanges[serviceChannel.serviceName];
            if (partialRange) {
                partialRange.compute(self.relaysFor[serviceChannel.serviceName], null, now);
            }
        }

        if (serviceChannel.serviceProxyMode === 'forward') {
            self.changeToExit(serviceChannel);
        } else {
            self.updateServiceNodes(serviceChannel, now);
        }
    } else {
        if (self.partialAffinityEnabled) {
            delete self.partialRanges[serviceChannel.serviceName];
        }

        if (serviceChannel.serviceProxyMode === 'exit') {
            self.changeToForward(exitNodes, serviceChannel, now);
        } else {
            self.updateExitNodes(exitNodes, serviceChannel);
        }
    }
};

ServiceDispatchHandler.prototype.changeToExit =
function changeToExit(serviceChannel) {
    var self = this;

    var oldMode = serviceChannel.serviceProxyMode;
    serviceChannel.serviceProxyMode = 'exit';
    serviceChannel.peers.clear();
    self.roleTransitionEvent.emit(self, {
        serviceChannel: serviceChannel,
        oldMode: oldMode,
        newMode: 'exit'
    });

    self.logger.info(
        'Changing to exit node',
        self.extendLogInfo({
            oldMode: oldMode,
            newMode: 'exit',
            serviceName: serviceChannel.serviceName
        })
    );
};

ServiceDispatchHandler.prototype.updateServiceNodes =
function updateServiceNodes(serviceChannel, now) {
    var self = this;

    if (self.partialAffinityEnabled) {
        self.ensurePartialConnections(
            serviceChannel, serviceChannel.serviceName, null,
            'topologyChange', now);
    }
};

ServiceDispatchHandler.prototype.changeToForward =
function changeToForward(exitNodes, serviceChannel, now) {
    var self = this;

    var oldMode = serviceChannel.serviceProxyMode;
    serviceChannel.serviceProxyMode = 'forward';

    var i;
    var peers = serviceChannel.peers.values();
    serviceChannel.peers.clear();
    for (i = 0; i < peers.length; i++) {
        var peer = peers[i];
        self.ensurePeerDisconnected(
            serviceChannel.serviceName, peer,
            'hyperbahn membership change', now);
    }

    // TODO: transmit prior known registration data to new owner(s) to
    // speed convergence / deal with transitions better:
    //     var oldHostPorts = serviceChannel.peers.keys();
    //     var oldPeers = serviceChannel.peers.values();
    //     serviceChannel.peers.clear();
    //     ... send rpc to new exit nodes
    var exitNames = Object.keys(exitNodes);
    for (i = 0; i < exitNames.length; i++) {
        self._getServicePeer(serviceChannel, exitNames[i]);
    }
    self.roleTransitionEvent.emit(self, {
        serviceChannel: serviceChannel,
        oldMode: oldMode,
        newMode: 'forward'
    });

    self.logger.info(
        'Changing to forward node',
        self.extendLogInfo({
            oldMode: oldMode,
            newMode: 'forward',
            serviceName: serviceChannel.serviceName
        })
    );
};

ServiceDispatchHandler.prototype.updateExitNodes =
function updateExitNodes(exitNodes, serviceChannel) {
    var self = this;
    var i;
    var oldNames = serviceChannel.peers.keys();
    for (i = 0; i < oldNames.length; i++) {
        if (!exitNodes[oldNames[i]]) {
            serviceChannel.peers.delete(oldNames[i]);
        }
    }
    var exitNames = Object.keys(exitNodes);
    for (i = 0; i < exitNames.length; i++) {
        self._getServicePeer(serviceChannel, exitNames[i]);
    }
};

ServiceDispatchHandler.prototype.isBlocked =
function isBlocked(cn, serviceName) {
    var self = this;
    cn = cn || '*';
    serviceName = serviceName || '*';

    if (self.blockingTable &&
        (self.blockingTable[cn + '~~' + serviceName] ||
        self.blockingTable['*~~' + serviceName] ||
        self.blockingTable[cn + '~~*'])) {
        return true;
    }

    if (self.blockingTableRemoteConfig &&
        (self.blockingTableRemoteConfig[cn + '~~' + serviceName] ||
        self.blockingTableRemoteConfig['*~~' + serviceName] ||
        self.blockingTableRemoteConfig[cn + '~~*'])) {
        return true;
    }

    return false;
};

ServiceDispatchHandler.prototype.block =
function block(cn, serviceName) {
    var self = this;
    cn = cn || '*';
    serviceName = serviceName || '*';
    self.blockingTable = self.blockingTable || {};
    assert(cn !== '*' || serviceName !== '*', 'at least one of cn/serviceName should be provided');
    self.blockingTable[cn + '~~' + serviceName] = Date.now();
};

ServiceDispatchHandler.prototype.unblock =
function unblock(cn, serviceName) {
    var self = this;
    if (!self.blockingTable) {
        return;
    }

    cn = cn || '*';
    serviceName = serviceName || '*';
    delete self.blockingTable[cn + '~~' + serviceName];
    if (Object.keys(self.blockingTable).length === 0) {
        self.blockingTable = null;
    }
};

ServiceDispatchHandler.prototype.blockRemoteConfig =
function blockRemoteConfig(cn, serviceName) {
    var self = this;
    cn = cn || '*';
    serviceName = serviceName || '*';
    self.blockingTableRemoteConfig = self.blockingTableRemoteConfig || {};
    assert(cn !== '*' || serviceName !== '*', 'at least one of cn/serviceName should be provided');
    self.blockingTableRemoteConfig[cn + '~~' + serviceName] = Date.now();
};

ServiceDispatchHandler.prototype.unblockAllRemoteConfig =
function unblockAllRemoteConfig() {
    var self = this;
    self.blockingTableRemoteConfig = null;
};

ServiceDispatchHandler.prototype.isExitFor =
function isExitFor(serviceName) {
    var self = this;

    // faster check than calls into ringpop
    var serviceChannel = self.channel.subChannels[serviceName];
    if (!serviceChannel) {
        return self.egressNodes.isExitFor(serviceName);
    }

    return serviceChannel.serviceProxyMode === 'exit';
};

ServiceDispatchHandler.prototype.setReapPeersPeriod =
function setReapPeersPeriod(period) {
    // period === 0 means never / disabled, and is the default
    var self = this;

    self.peerReaper.setInterval(period);
};

ServiceDispatchHandler.prototype.setPrunePeersPeriod =
function setPrunePeersPeriod(period) {
    // period === 0 means never / disabled, and is the default
    var self = this;

    self.peerPruner.setInterval(period);
};

ServiceDispatchHandler.prototype.pruneSinglePeer =
function pruneSinglePeer(hostPort, pruneInfo) {
    var self = this;

    var peer = self.channel.peers.get(hostPort);
    if (!peer) {
        return;
    }

    if (peer.draining) {
        self.logger.info(
            'skipping peer prune drain, already draining',
            self.extendLogInfo({
                peer: peer.hostPort,
                priorDrainReason: peer.drainReason
            })
        );
        return;
    }

    peer.drain({
        goal: peer.DRAIN_GOAL_CLOSE_DRAINED,
        reason: 'peer pruned because ' + pruneInfo.reason,
        direction: 'out',
        timeout: self.drainTimeout
    }, thenResetPeer);

    // TODO: stat?
    self.logger.info(
        'draining pruned peer',
        self.extendLogInfo(
            peer.extendLogInfo(peer.draining.extendLogInfo({}))
        )
    );

    function thenResetPeer(err) {
        if (err) {
            self.logger.warn(
                'error closing drained pruned peer connections',
                self.extendLogInfo(
                    peer.extendLogInfo(peer.draining.extendLogInfo({
                        error: err
                    }))
                )
            );
        }
        peer.clearDrain('reset after prune drain done');
    }
};

ServiceDispatchHandler.prototype.reapSinglePeer =
function reapSinglePeer(hostPort, serviceNames, now) {
    var self = this;

    if (self.knownPeers[hostPort]) {
        return;
    }

    var peer = self.channel.peers.get(hostPort);
    if (!peer) {
        return;
    }

    if (peer.draining) {
        if (peer.draining.reason.indexOf('peer pruned') !== 0) {
            self.logger.warn(
                'skipping peer reap due to unknown drain state',
                self.extendLogInfo(
                    peer.extendLogInfo(peer.draining.extendLogInfo({}))
                )
            );
            return;
        }
        self.logger.info(
            'peer reaper canceling peer prune drain',
            self.extendLogInfo(
                peer.extendLogInfo(peer.draining.extendLogInfo({}))
            )
        );
        peer.clearDrain('superceded by peer reap');
    }

    for (var i = 0; i < serviceNames.length; i++) {
        var serviceName = serviceNames[i];
        var serviceChannel = self.getServiceChannel(serviceName);
        if (serviceChannel) {
            serviceChannel.peers.delete(hostPort);
        }
        self.deletePeerIndex(serviceName, hostPort);
        var partialRange = self.partialRanges[serviceName];
        partialRange.removeWorker(hostPort, now);
    }

    peer.drain({
        goal: peer.DRAIN_GOAL_CLOSE_PEER,
        reason: 'reaped for expired advertisement',
        direction: 'both',
        timeout: self.drainTimeout
    }, thenDeleteIt);

    // TODO: stat?
    self.logger.info(
        'reaping dead peer',
        self.extendLogInfo(
            peer.extendLogInfo(peer.draining.extendLogInfo({}))
        )
    );

    function thenDeleteIt(err) {
        if (err) {
            self.logger.warn(
                'error closing reaped peer, deleting it anyhow',
                self.extendLogInfo(
                    peer.extendLogInfo(peer.draining.extendLogInfo({
                        error: err
                    }))
                )
            );
        }
        self.channel.peers.delete(hostPort);
    }
};

ServiceDispatchHandler.prototype.emitPeriodicServiceStats =
function emitPeriodicServiceStats(serviceChannel, serviceName) {
    var self = this;

    var incoming = 0;
    var outgoing = 0;
    var anyway = 0;

    var prefix = 'services.' + clean(serviceName, 'no-service') + '.';

    var hostPorts = serviceChannel.peers.keys();
    for (var i = 0; i < hostPorts.length; i++) {
        var hostPort = hostPorts[i];
        var peer = serviceChannel.peers.get(hostPort);
        anyway += peer.connections.length;
        for (var j = 0; j < peer.connections.length; j++) {
            var connection = peer.connections[j];
            if (connection.direction === 'in') {
                incoming++;
            } else if (connection.direction === 'out') {
                outgoing++;
            }
        }
    }

    self.statsd.gauge(prefix + 'peers', hostPorts.length);
    self.statsd.gauge(prefix + 'connections.in', incoming);
    self.statsd.gauge(prefix + 'connections.out', outgoing);
    self.statsd.gauge(prefix + 'connections.any', anyway);
};

ServiceDispatchHandler.prototype.onCircuitStateChange =
function onCircuitStateChange(change) {
    var self = this;

    var circuit = change.circuit;
    var oldState = change.oldState;
    var state = change.state;

    if (oldState && oldState.healthy !== state.healthy) {
        // unhealthy -> healthy
        if (state.healthy) {
            self.statsd.increment('circuits.healthy.total', 1);
            self.statsd.increment(
                'circuits.healthy.by-caller.' +
                    clean(circuit.callerName) + '.' +
                    clean(circuit.serviceName) + '.' +
                    clean(circuit.endpointName),
                1
            );
            self.statsd.increment(
                'circuits.healthy.by-service.' +
                    clean(circuit.serviceName) + '.' +
                    clean(circuit.callerName) + '.' +
                    clean(circuit.endpointName),
                1
            );
            self.logger.info(
                'circuit returned to good health',
                self.extendLogInfo(circuit.extendLogInfo({}))
            );
        // healthy -> unhealthy
        } else {
            self.statsd.increment('circuits.unhealthy.total', 1);
            self.statsd.increment(
                'circuits.unhealthy.by-caller.' +
                    clean(circuit.callerName) + '.' +
                    clean(circuit.serviceName) + '.' +
                    clean(circuit.endpointName),
                1
            );
            self.statsd.increment(
                'circuits.unhealthy.by-service.' +
                    clean(circuit.serviceName) + '.' +
                    clean(circuit.callerName) + '.' +
                    clean(circuit.endpointName),
                1
            );
            self.logger.info(
                'circuit became unhealthy',
                self.extendLogInfo(circuit.extendLogInfo({}))
            );
        }
    }
};

ServiceDispatchHandler.prototype.destroy =
function destroy() {
    var self = this;
    if (self.destroyed) {
        return;
    }
    self.destroyed = true;
    self.peerPruner.stop();
    self.peerReaper.stop();
    self.servicePurger.stop();
    self.statEmitter.stop();
    self.rateLimiter.destroy();
};

ServiceDispatchHandler.prototype.initCircuits =
function initCircuits() {
    var self = this;

    self.circuits = new Circuits({
        timeHeap: self.channel.timeHeap,
        timers: self.channel.timers,
        random: self.random,
        egressNodes: self.egressNodes,
        config: self.circuitsConfig
    });

    self.circuits.circuitStateChangeEvent.on(self.boundOnCircuitStateChange);
};

ServiceDispatchHandler.prototype.enableCircuits =
function enableCircuits() {
    var self = this;

    if (self.circuitsEnabled) {
        return;
    }
    self.circuitsEnabled = true;

    if (!self.circuits) {
        self.initCircuits();
    }

    var serviceNames = Object.keys(self.channel.subChannels);
    for (var index = 0; index < serviceNames.length; index++) {
        var serviceName = serviceNames[index];
        var subChannel = self.channel.subChannels[serviceName];
        if (subChannel.handler.type === 'tchannel.relay-handler' &&
            subChannel.serviceProxyMode === 'exit'
        ) {
            subChannel.handler.circuits = self.circuits;
        }
    }
};

ServiceDispatchHandler.prototype.disableCircuits =
function disableCircuits() {
    var self = this;

    if (!self.circuitsEnabled) {
        return;
    }
    self.circuitsEnabled = false;

    var serviceNames = Object.keys(self.channel.subChannels);
    for (var index = 0; index < serviceNames.length; index++) {
        var serviceName = serviceNames[index];
        var subChannel = self.channel.subChannels[serviceName];
        if (subChannel.handler.type === 'tchannel.relay-handler' &&
            subChannel.serviceProxyMode === 'exit'
        ) {
            subChannel.handler.circuits = null;
        }
    }
};

ServiceDispatchHandler.prototype.enableRateLimiter =
function enableRateLimiter() {
    var self = this;
    self.rateLimiterEnabled = true;
};

ServiceDispatchHandler.prototype.disableRateLimiter =
function disableRateLimiter() {
    var self = this;
    self.rateLimiterEnabled = false;
};

ServiceDispatchHandler.prototype.setPartialAffinityEnabled =
function setPartialAffinityEnabled(enabled) {
    var self = this;
    self.partialAffinityEnabled = !!enabled;
    self.partialRanges = Object.create(null);
    self.connectedServicePeers = Object.create(null);
    self.connectedPeerServices = Object.create(null);
};

ServiceDispatchHandler.prototype.extendLogInfo =
function extendLogInfo(info) {
    var self = this;

    self.channel.extendLogInfo(info);

    info.affineServices = Object.keys(self.exitServices);

    info.circuitsEnabled = self.circuitsEnabled;
    info.rateLimiterEnabled = self.rateLimiterEnabled;
    info.partialAffinityEnabled = self.partialAffinityEnabled;

    info.minPeersPerWorker = self.minPeersPerWorker;
    info.minPeersPerRelay = self.minPeersPerRelay;

    return info;
};

ServiceDispatchHandler.prototype.setPeerHeapEnabled =
function setPeerHeapEnabled(peerHeapEnabledServices, peerHeapEnabledGlobal) {
    var self = this;

    assert(typeof peerHeapEnabledServices === 'object');
    self.peerHeapEnabledServices = peerHeapEnabledServices;
    self.peerHeapEnabledGlobal = peerHeapEnabledGlobal;

    var keys = Object.keys(self.channel.subChannels);
    var i;
    for (i = 0; i < keys.length; i++) {
        var serviceName = keys[i];
        var enabled = self.peerHeapEnabledGlobal;
        if (serviceName in self.peerHeapEnabledServices) {
            enabled = self.peerHeapEnabledServices[serviceName];
        }
        self.channel.subChannels[serviceName].setChoosePeerWithHeap(enabled);
    }
};

// TODO Consider sharding by hostPort and indexing exit exitNodes by hostPort.
// We also have to shard by serviceName and store the serviceName <-> hostPort
// information under the "service exitNodes".  This means that sharding by
// hostPort gives an even spread of socket distribution. i.e. if we shard
// dispatch to 5 exit exitNodes and some small lulzy service to 5 exit
// exitNodes we wont have massive imbalance of dispatch having 500 workers and
// the small service having 2 workers.  We would need two hops to find an exit
// node though

module.exports = ServiceDispatchHandler;

function addIndexEntry(index, keya, keyb, value) {
    var level = index[keya];
    if (!level) {
        level = Object.create(null);
        index[keya] = level;
    }
    level[keyb] = value;
}

function deleteIndexEntry(index, keya, keyb) {
    var level = index[keya];
    if (level && level[keyb]) {
        delete level[keyb];
        if (isObjectEmpty(level)) {
            delete index[keya];
        }
    }
}

/* eslint-disable guard-for-in, no-unused-vars */

function isObjectEmpty(obj) {
    for (var prop in obj) {
        return false;
    }
    return true;
}

/* eslint-enable guard-for-in, no-unused-vars */
