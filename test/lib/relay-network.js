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

var tape = require('tape');
var parallel = require('run-parallel');
var NullStatsd = require('uber-statsd-client/null');
var tapeCluster = require('tape-cluster');
var allocCluster = require('tchannel/test/lib/alloc-cluster.js');
var EndpointHandler = require('tchannel/endpoint-handler.js');
var timers = require('timers');

var BatchStatsd = require('tchannel/lib/statsd');
var FakeEgressNodes = require('./fake-egress-nodes.js');
var ServiceProxy = require('../../service-proxy.js');
var HyperbahnHandler = require('../../handler.js');

/*eslint complexity: [2, 15], max-statements: [2, 50] */
function RelayNetwork(options) {
    if (!(this instanceof RelayNetwork)) {
        return new RelayNetwork(options);
    }

    var self = this;

    self.numRelays = options.numRelays || 3;
    self.numInstancesPerService = options.numInstancesPerService || 3;
    self.serviceNames = options.serviceNames || ['alice', 'bob', 'charlie'];
    self.kValue = options.kValue || 2;
    self.circuitsConfig = options.circuitsConfig || {};
    self.clusterOptions = options.cluster || options.clusterOptions || {};

    self.timers = options.timers;
    if (self.timers) {
        self.clusterOptions.timers = self.timers;
    }

    self.servicePurgePeriod = options.servicePurgePeriod;

    self.exemptServices = options.exemptServices;
    self.rpsLimitForServiceName = options.rpsLimitForServiceName;
    self.totalRpsLimit = options.totalRpsLimit;
    self.defaultServiceRpsLimit = options.defaultServiceRpsLimit;
    self.defaultTotalKillSwitchBuffer = options.defaultTotalKillSwitchBuffer;
    self.rateLimiterBuckets = options.rateLimiterBuckets;
    self.rateLimiterEnabled = options.rateLimiterEnabled;

    self.numPeers = self.numRelays + self.serviceNames.length * self.numInstancesPerService;
    self.clusterOptions.numPeers = self.numPeers;
    self.cluster = null;

    // The topology gets mutated by all the fake egress nodes to get consensus
    self.topology = null;
    self.relayChannels = null;
    self.serviceChannels = null;
    self.serviceChannelsByName = null;

    var relayIndexes = [];
    for (var relayIndex = 0; relayIndex < self.numRelays; relayIndex++) {
        relayIndexes.push(relayIndex);
    }
    self.relayIndexes = relayIndexes;

    var instanceIndexes = [];
    for (var instanceIndex = 0; instanceIndex < self.numInstancesPerService; instanceIndex++) {
        instanceIndexes.push(instanceIndex);
    }
    self.instanceIndexes = instanceIndexes;
}

RelayNetwork.test = tapeCluster(tape, RelayNetwork);

RelayNetwork.prototype.bootstrap = function bootstrap(cb) {
    var self = this;

    allocCluster(self.clusterOptions).ready(clusterReady);

    function clusterReady(cluster) {
        self.setCluster(cluster);
        self.connect(cb);
    }
};

RelayNetwork.prototype.close = function close(cb) {
    var self = this;
    self.relayChannels.forEach(function each(relayChannel) {
        relayChannel.handler.destroy();
    });
    self.cluster.destroy();
    cb();
};

RelayNetwork.prototype.setCluster = function setCluster(cluster) {
    var self = this;
    self.cluster = cluster;

    // consume channels for the following services
    var nextChannelIndex = 0;

    self.relayChannels = self.relayIndexes.map(function mappy() {
        return cluster.channels[nextChannelIndex++];
    });

    self.serviceChannels = [];
    self.serviceChannelsByName = {};
    self.serviceNames.forEach(function each(serviceName) {
        var channels = self.instanceIndexes.map(function mappy2(instanceIndex) {
            return cluster.channels[nextChannelIndex++];
        });
        self.serviceChannels.push(channels);
        self.serviceChannelsByName[serviceName] = channels;
    });

    // Create a relay topology for egress nodes.
    self.topology = {};
    self.serviceChannels.forEach(function each(channels, index) {
        var serviceName = self.serviceNames[index];
        var relayHostPorts = [];
        for (var kIndex = 0; kIndex < self.kValue; kIndex++) {
            var hostPort = self.relayChannels[
                (index + kIndex) %
                self.relayChannels.length
            ].hostPort;

            if (relayHostPorts.indexOf(hostPort) === -1) {
                relayHostPorts.push(hostPort);
            }
        }
        self.topology[serviceName] = relayHostPorts;
    });

    self.egressNodesForRelay = self.relayChannels.map(function eachRelay(relayChannel, index) {
        return new FakeEgressNodes({
            topology: self.topology,
            hostPort: relayChannel.hostPort,
            relayChannels: self.relayChannels,
            kValue: self.kValue
        });
    });

    // Set up relays
    self.relayChannels.forEach(function each(relayChannel, index) {
        var egressNodes = self.egressNodesForRelay[index];
        var statsd = new NullStatsd();

        relayChannel.handler = new ServiceProxy({
            channel: relayChannel,
            logger: self.cluster.logger,
            statsd: statsd,
            batchStats: new BatchStatsd({
                statsd: statsd,
                logger: self.cluster.logger,
                timers: timers
            }),
            egressNodes: egressNodes,
            servicePurgePeriod: self.servicePurgePeriod,
            exemptServices: self.exemptServices,
            rpsLimitForServiceName: self.rpsLimitForServiceName,
            totalRpsLimit: self.totalRpsLimit,
            defaultServiceRpsLimit: self.defaultServiceRpsLimit,
            defaultTotalKillSwitchBuffer: self.defaultTotalKillSwitchBuffer,
            rateLimiterBuckets: self.rateLimiterBuckets,
            rateLimiterEnabled: self.rateLimiterEnabled,
            circuitsConfig: self.circuitsConfig
        });

        var hyperbahnChannel = relayChannel.makeSubChannel({
            serviceName: 'hyperbahn'
        });
        var hyperbahnHandler = HyperbahnHandler({
            channel: hyperbahnChannel,
            egressNodes: egressNodes,
            callerName: 'hyperbahn'
        });
        hyperbahnChannel.handler = hyperbahnHandler;

        // In response to artificial advertisement
        self.serviceNames.forEach(function eachServiceName(serviceName, index2) {
            if (egressNodes.isExitFor(serviceName)) {
                self.serviceChannels[index2].forEach(function each(serviceChannel) {
                    relayChannel.handler.getServicePeer(serviceName, serviceChannel.hostPort);
                });
            }
        });
    });

    // Create and connect service channels
    self.subChannels = [];
    self.subChannelsByName = {};
    self.serviceChannels.forEach(function each(channels, serviceIndex) {
        var serviceName = self.serviceNames[serviceIndex];
        var subChannels = channels.map(function mappy(channel, channelIndex) {
            var subChannel = channel.makeSubChannel({
                serviceName: serviceName,
                requestDefaults: {
                    headers: {
                        cn: serviceName
                    },
                    hasNoParent: true
                },
                peers: self.topology[serviceName]
            });

            // Set up server
            var endpointHandler = new EndpointHandler(serviceName);
            subChannel.handler = endpointHandler;

            return subChannel;
        });
        self.subChannels.push(subChannels);
        self.subChannelsByName[serviceName] = subChannels;
    });

};

RelayNetwork.prototype.forEachSubChannel = function forEachSubChannel(callback) {
    var self = this;
    self.subChannels.forEach(function each(subChannels, serviceIndex) {
        var serviceName = self.serviceNames[serviceIndex];
        subChannels.forEach(function each(subChannel, instanceIndex) {
            callback(subChannel, serviceName, instanceIndex);
        });
    });
};

RelayNetwork.prototype.connect = function connect(callback) {
    var self = this;

    function connectRelays(cb) {
        return self.cluster.connectChannels(
            self.relayChannels,
            cb
        );
    }

    function connectServices(cb) {
        self.connectServices(cb);
    }

    return parallel([connectRelays, connectServices], callback);
};

RelayNetwork.prototype.connectServices = function connectServices(callback) {
    var self = this;

    var plans = [];

    self.relayChannels.forEach(function each(relayChannel, relayIndex) {
        self.serviceNames.forEach(function each(serviceName) {
            if (self.egressNodesForRelay[relayIndex].isExitFor(serviceName)) {
                plans.push(planToConnect(
                    relayChannel,
                    self.serviceChannelsByName[serviceName]
                ));
            }
        });
    });

    function planToConnect(channel, channels) {
        return function connect(cb) {
            return self.cluster.connectChannelToChannels(channel, channels, cb);
        };
    }

    return parallel(plans, callback);
};

RelayNetwork.prototype.register = function register(arg1, handler) {
    var self = this;
    self.forEachSubChannel(function registerHanlder(subChannel) {
        subChannel.handler.register(arg1, handler);
    });
};

RelayNetwork.prototype.registerEchoHandlers = function registerEchoHandlers() {
    var self = this;
    self.register('echo', function echo(req, res, arg1, arg2) {
        res.sendOk(arg1, arg2);
    });
};

RelayNetwork.prototype.send = function send(options, arg1, arg2, arg3, callback) {
    var self = this;
    var callerChannel = self.subChannelsByName[options.callerName][options.callerIndex || 0];
    callerChannel.request({
        serviceName: options.serviceName,
        headers: {
            as: 'raw',
            cn: options.callerName
        },
        hasNoParent: true
    }).send(arg1, arg2, arg3, callback);
};

RelayNetwork.prototype.exercise = function exercise(count, delay, eachRequest, eachResponse, callback) {
    var self = this;

    function tick(count2, delay2, callback2) {

        eachRequest(onResponse);

        function onResponse(err, res, arg2, arg3) {
            self.timers.advance(delay2);
            if (eachResponse) {
                eachResponse(err, res, arg2, arg3);
            }
            if (count2) {
                tick(count2 - 1, delay2, callback2);
            } else {
                callback2();
            }
        }
    }

    tick(count, delay, callback);
};

RelayNetwork.prototype.getCircuit = function getCircuit(relayIndex, callerName, serviceName, endpointName) {
    var self = this;
    var serviceDispatchHandler = self.relayChannels[relayIndex].handler;
    var circuits = serviceDispatchHandler.circuits;
    return circuits.getCircuit(callerName, serviceName, endpointName);
};

RelayNetwork.prototype.getCircuitTuples = function getCircuitTuples(relayIndex) {
    var self = this;
    var serviceDispatchHandler = self.relayChannels[relayIndex].handler;
    var circuits = serviceDispatchHandler.circuits;
    return circuits.getCircuitTuples();
};

module.exports = RelayNetwork;
