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

/* jshint maxparams:5 */

var assert = require('assert');
var util = require('util');
var fs = require('fs');
var path = require('path');
var setTimeout = require('timers').setTimeout;
var Errors = require('tchannel/errors.js');
var TChannelJSON = require('tchannel/as/json');
var TChannelThrift = require('tchannel/as/thrift');
var TChannelEndpointHandler = require('tchannel/endpoint-handler');

var MAX_RELAY_AD_ATTEMPTS = 2;
var RELAY_AD_RETRY_TIME = 1 * 1000;
var RELAY_AD_TIMEOUT = 500;

var RELAY_TIMEOUT = 500;

var thriftSource = fs.readFileSync(
    path.join(__dirname, 'hyperbahn.thrift'), 'utf8'
);

module.exports = HyperbahnHandler;

// TODO: should be part of Hyperbahn error file
var TypedError = require('error/typed');
var NoPeersAvailable = TypedError({
    type: 'hyperbahn.no-peers-available',
    nameAsThrift: 'noPeersAvailable',
    message: 'no peer available for {serviceName}',
    serviceName: null
});

var InvalidServiceName = TypedError({
    type: 'hyperbahn.invalid-service-name',
    nameAsThrift: 'invalidServiceName',
    message: 'invalid service name: {serviceName}',
    serviceName: null
});

function HyperbahnHandler(options) {
    if (!(this instanceof HyperbahnHandler)) {
        return new HyperbahnHandler(options);
    }

    var self = this;
    TChannelEndpointHandler.call(self, 'hyperbahn');

    assert(options && options.channel, 'channel required');
    assert(options && options.egressNodes, 'egressNodes required');
    assert(options && options.callerName, 'callerName required');

    // TODO support blackList

    self.channel = options.channel;
    self.egressNodes = options.egressNodes;
    self.callerName = options.callerName;

    self.tchannelJSON = TChannelJSON({
        logger: self.channel.logger
    });

    self.tchannelThrift = TChannelThrift({
        channel: self.channel,
        logger: self.channel.logger,
        source: thriftSource
    });

    // TODO replace JSON with real bufrw handlers for this
    self.tchannelJSON.register(self, 'ad', self,
        self.handleAdvertise);
    self.tchannelJSON.register(self, 'relay-ad', self,
        self.handleRelayAdvertise);
    self.tchannelJSON.register(self, 'unad', self,
        self.handleUnadvertise);
    self.tchannelJSON.register(self, 'relay-unad', self,
        self.handleRelayUnadvertise);

    self.tchannelThrift.register(self, 'Hyperbahn::discover', self,
        self.discover);
    self.tchannelThrift.register(self, 'Hyperbahn::discoverAffine', self,
        self.discoverAffine);

    self.relayAdTimeout = options.relayAdTimeout ||
        RELAY_AD_TIMEOUT;
    self.relayAdRetryTime = options.relayAdRetryTime ||
        RELAY_AD_RETRY_TIME;
    self.maxRelayAdAttempts = options.maxRelayAdAttempts ||
        MAX_RELAY_AD_ATTEMPTS;

    self.relayTimeout = options.relayTimeout || RELAY_TIMEOUT;
}
util.inherits(HyperbahnHandler, TChannelEndpointHandler);

HyperbahnHandler.prototype.type = 'hyperbahn.advertisement-handler';

/*  req: {
        services: Array<{
            serviceName: String,
            cost: Number
        }>
    }

    res: {
        connectionCount: Number
    }
*/
HyperbahnHandler.prototype.handleAdvertise =
function handleAdvertise(handler, req, arg2, arg3, cb) {
    handler.sendRelays(req, arg2, arg3, 'relay-ad', cb);
};

HyperbahnHandler.prototype.handleUnadvertise =
function handleUnadvertise(handler, req, arg2, arg3, cb) {
    handler.sendRelays(req, arg2, arg3, 'relay-unad', cb);
};

HyperbahnHandler.prototype.sendRelays =
function sendRelays(req, arg2, arg3, endpoint, cb) {
    /*eslint max-statements: [2, 25], max-params: [2, 6]*/
    var self = this;
    var services = arg3.services;

    var servicesByExitNode = {};

    for (var i = 0; i < services.length; i++) {
        var service = services[i];
        service.hostPort = req.connection.remoteName;

        var serviceName = service.serviceName;
        if (serviceName === '') {
            continue;
        }

        // TODO: cache / use sub-channel peers
        var exitNodes = self.egressNodes.exitsFor(serviceName);
        var exitHosts = Object.keys(exitNodes);

        for (var j = 0; j < exitHosts.length; j++) {
            var exitNode = exitHosts[j];

            var relayReq = servicesByExitNode[exitNode];
            if (!relayReq) {
                relayReq = servicesByExitNode[exitNode] = [];
            }

            relayReq.push(service);
        }
    }

    var exitNodeKeys = Object.keys(servicesByExitNode);
    var counter = 1 + exitNodeKeys.length;
    for (var k = 0; k < exitNodeKeys.length; k++) {
        var hostPort = exitNodeKeys[k];
        var exitNodeServices = servicesByExitNode[hostPort];

        self.sendRelay({
            hostPort: hostPort,
            services: exitNodeServices,
            inreq: req,
            endpoint: endpoint
        }, onFinish);
    }

    onFinish();

    // TODO remove blocking on fanout finish. Requires fixing
    // hyperbahn tests upstream
    function onFinish() {
        if (--counter === 0) {
            cb(null, {
                ok: true,
                head: null,
                body: {
                    connectionCount: exitNodeKeys.length
                }
            });
        }
    }
};

HyperbahnHandler.prototype.sendAdvertise =
function sendAdvertise(services, options, callback) {
    var self = this;

    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    options.serviceName = 'hyperbahn';
    options.trace = false;
    options.hasNoParent = true;
    options.headers = options.headers || {};
    options.headers.cn = self.callerName;

    var req = self.channel.request(options);
    self.tchannelJSON.send(req, 'ad', null, {
        services: services
    }, callback);
};

/*  req: {
        services: Array<{
            serviceName: String,
            hostPort: String,
            cost: Number
        }>
    }

    res: {}
*/
HyperbahnHandler.prototype.handleRelayAdvertise =
function handleRelayAdvertise(handler, req, arg2, arg3, cb) {
    handler.handleRelay('ad', req, arg2, arg3, cb);
};

HyperbahnHandler.prototype.handleRelayUnadvertise =
function handleRelayUnadvertise(handler, req, arg2, arg3, cb) {
    handler.handleRelay('unad', req, arg2, arg3, cb);
};

HyperbahnHandler.prototype.handleRelay =
function handleRelay(endpoint, req, arg2, arg3, cb) {
    var self = this;
    var services = arg3.services;
    var logger = self.channel.logger;

    for (var i = 0; i < services.length; i++) {
        var service = services[i];
        if (endpoint === 'ad') {
            self.advertise(service);
        } else if (endpoint === 'unad') {
            self.unadvertise(service);
        } else {
            logger.error('Unexpected endpoint for relay', {
                endpoint: endpoint,
                service: service
            });
        }
    }

    cb(null, {
        ok: true,
        head: null,
        body: {}
    });
};

HyperbahnHandler.prototype.sendRelay =
function sendRelay(opts, callback) {
    var self = this;

    var attempts = 0;

    tryRequest();

    // TODO: move functions out to methods
    function tryRequest() {
        attempts++;

        self.channel.waitForIdentified({
            host: opts.hostPort
        }, onIdentified);

        function onIdentified(err) {
            if (err) {
                return onResponse(err);
            }

            self.tchannelJSON.send(self.channel.request({
                host: opts.hostPort,
                serviceName: 'hyperbahn',
                trace: false,
                timeout: self.relayAdTimeout,
                headers: {
                    cn: self.callerName
                },
                parent: opts.inreq,
                retryFlags: {
                    never: true
                }
            }), opts.endpoint, null, {
                services: opts.services
            }, onResponse);
        }

        function onResponse(err, response) {
            if (response && response.ok) {
                return callback(null, null);
            }

            var codeName = Errors.classify(err);
            if (attempts <= self.maxRelayAdAttempts && err &&
                (
                    codeName === 'NetworkError' ||
                    codeName === 'Timeout'
                )
            ) {
                setTimeout(tryRequest, self.relayAdRetryTime);
            } else {
                self.logError(err, opts, response);

                callback(null, null);
            }
        }
    }
};

HyperbahnHandler.prototype.logError =
function logError(err, opts, response) {
    var self = this;

    var logger = self.channel.logger;

    var logOptions = {
        exitNode: opts.hostPort,
        services: opts.services,
        responseBody: response && response.body,
        error: err
    };

    if (Errors.isFatal(err)) {
        logger.error('Relay advertise failed with unexpected err', logOptions);
    } else {
        logger.warn('Relay advertise failed with expected err', logOptions);
    }
};

HyperbahnHandler.prototype.advertise =
function advertise(service) {
    var self = this;
    self.channel.topChannel.handler.refreshServicePeer(service.serviceName, service.hostPort);
};

HyperbahnHandler.prototype.unadvertise =
function unadvertise(service) {
    var self = this;
    self.channel.topChannel.handler.removeServicePeer(service.serviceName, service.hostPort);
};

function convertHosts(hosts) {
    var res = [];
    for (var i = 0; i < hosts.length; i++) {
        var strs = hosts[i].split(':');
        var obj = {
            port: parseInt(strs[1], 10)
        };
        strs = strs[0].split('.');
        obj.ip = {
            ipv4: parseInt(strs[3], 10) + (parseInt(strs[2], 10) << 8) +
                (parseInt(strs[1], 10) << 16) + (parseInt(strs[0], 10) << 24)
        };

        res.push(obj);
    }

    return res;
}

HyperbahnHandler.prototype.discover =
function discover(handler, req, head, body, cb) {
    var serviceName = body.query.serviceName;
    if (serviceName.length === 0) {
        cb(null, {
            ok: false,
            body: InvalidServiceName({
                serviceName: serviceName
            }),
            typeName: 'invalidServiceName'
        });
        return;
    }

    var topChannel = handler.channel.topChannel;
    var svcchan = topChannel.handler.getOrCreateServiceChannel(serviceName);

    if (svcchan.serviceProxyMode === 'forward' &&
        req.headers.cn !== 'hyperbahn'
    ) {
        handler._forwardToRemoteDiscover(req, svcchan, body, cb);
        return;
    }

    handler._getDiscoverHosts(serviceName, cb);
};

HyperbahnHandler.prototype.discoverAffine =
function discoverAffine(handler, req, head, body, cb) {
    var serviceName = body.query.serviceName;
    if (serviceName.length === 0) {
        cb(null, {
            ok: false,
            body: InvalidServiceName({
                serviceName: serviceName
            }),
            typeName: 'invalidServiceName'
        });
        return;
    }

    handler._getDiscoverHosts(serviceName, cb);
};

HyperbahnHandler.prototype._forwardToRemoteDiscover =
function _forwardToRemoteDiscover(parent, svcchan, body, cb) {
    var self = this;
    var serviceName = svcchan.serviceName;

    var endpoint = 'Hyperbahn::discoverAffine';
    // Since Hyperbahn is fully connected to service hosts,
    // any exit node suffices.
    self.tchannelThrift.send(svcchan.request({
        serviceName: 'hyperbahn',
        headers: {
            cn: 'hyperbahn'
        },
        parent: parent,
        retryFlags: {
            never: true
        },
        timeout: 1000,
        trace: false
    }), endpoint, null, body, handleForward);

    function handleForward(err, resp) {
        if (err) {
            self.channel.logger.error(
                'Failed to call discover API on exit node',
                parent.extendLogInfo({
                    error: err,
                    serviceName: serviceName
                })
            );
            return cb(err, null);
        }

        cb(null, resp);
    }
};

HyperbahnHandler.prototype._getDiscoverHosts =
function _getDiscoverHosts(serviceName, cb) {
    var self = this;

    var hosts = [];
    var svcchan = self.channel.topChannel.subChannels[serviceName];
    if (svcchan) {
        hosts = convertHosts(svcchan.peers.keys());
    }

    if (hosts.length === 0) {
        cb(null, {
            ok: false,
            body: NoPeersAvailable({
                serviceName: serviceName
            }),
            typeName: 'noPeersAvailable'
        });
        return;
    }

    cb(null, {
        ok: true,
        body: {
            peers: hosts
        }
    });
};
