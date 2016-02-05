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

var inherits = require('util').inherits;
var EventEmitter = require('tchannel/lib/event_emitter');
var Result = require('bufrw/result');

var states = require('./states.js');
var StateMachine = require('./state_machine.js');

// Each circuit uses the circuits collection as the "nextHandler" for
// "shouldRequest" to consult.  Peers use this hook to weight peers both by
// healthy and other factors, but the circuit only needs to know about health
// before forwarding.

function AlwaysShouldRequestHandler() { }

AlwaysShouldRequestHandler.prototype.shouldRequest = function shouldRequest() {
    return true;
};

var alwaysShouldRequestHandler = new AlwaysShouldRequestHandler();

function CircuitStateChange(circuit, oldState, state) {
    var self = this;
    self.circuit = circuit;
    self.oldState = oldState;
    self.state = state;
}

//  circuit = circuits                        : Circuits
//      .circuitsByServiceName[serviceName]   : ServiceCircuits
//      .circuitsByCallerName[callerName]     : EndpointCircuits
//      .circuitsByEndpointName[endpointName]

function EndpointCircuits(root) {
    var self = this;
    self.root = root;
    self.circuitsByEndpointName = {};
}

EndpointCircuits.prototype.getCircuit = function getCircuit(callerName, serviceName, endpointName) {
    var self = this;
    var circuit = self.circuitsByEndpointName['$' + endpointName];
    if (!circuit) {
        circuit = new Circuit(callerName, serviceName, endpointName);
        circuit.stateOptions = new states.StateOptions(circuit, self.root.stateOptions);
        circuit.stateChangedEvent.on(self.root.boundEmitCircuitStateChange);
        circuit.setState(states.HealthyState);
        self.circuitsByEndpointName['$' + endpointName] = circuit;
    }
    return circuit;
};

EndpointCircuits.prototype.collectCircuitTuples = function collectCircuitTuples(tuples) {
    var self = this;
    var endpointNames = Object.keys(self.circuitsByEndpointName);
    for (var index = 0; index < endpointNames.length; index++) {
        var endpointName = endpointNames[index];
        var circuit = self.circuitsByEndpointName[endpointName];
        tuples.push([circuit.callerName, circuit.serviceName, circuit.endpointName]);
    }
};

function ServiceCircuits(root) {
    var self = this;
    self.root = root;
    self.circuitsByCallerName = {};
}

ServiceCircuits.prototype.getCircuit = function getCircuit(callerName, serviceName, endpointName) {
    var self = this;
    var circuits = self.circuitsByCallerName['$' + callerName];
    if (!circuits) {
        circuits = new EndpointCircuits(self.root);
        self.circuitsByCallerName['$' + callerName] = circuits;
    }
    return circuits.getCircuit(callerName, serviceName, endpointName);
};

ServiceCircuits.prototype.collectCircuitTuples = function collectCircuitTuples(tuples) {
    var self = this;
    var callerNames = Object.keys(self.circuitsByCallerName);
    for (var index = 0; index < callerNames.length; index++) {
        var callerName = callerNames[index];
        var circuit = self.circuitsByCallerName[callerName];
        circuit.collectCircuitTuples(tuples);
    }
};

function Circuits(options) {
    var self = this;
    EventEmitter.call(self);
    self.circuitStateChangeEvent = self.defineEvent('circuitStateChange');
    self.circuitsByServiceName = {};
    self.config = options.config || {};

    self.stateOptions = new states.StateOptions(null, {
        timeHeap: options.timeHeap,
        timers: options.timers,
        random: options.random,
        nextHandler: alwaysShouldRequestHandler,
        period: self.config.period,
        maxErrorRate: self.config.maxErrorRate,
        minRequests: self.config.minRequests,
        probation: self.config.probation
    });
    self.egressNodes = options.egressNodes;
    self.boundEmitCircuitStateChange = boundEmitCircuitStateChange;

    function boundEmitCircuitStateChange(newStates, circuit) {
        self.emitCircuitStateChange(newStates, circuit);
    }
}

inherits(Circuits, EventEmitter);

Circuits.prototype.getCircuit = function getCircuit(callerName, serviceName, endpointName) {
    var self = this;
    var circuits = self.circuitsByServiceName['$' + serviceName];
    if (!circuits) {
        circuits = new ServiceCircuits(self);
        self.circuitsByServiceName['$' + serviceName] = circuits;
    }
    return circuits.getCircuit(callerName, serviceName, endpointName);
};

Circuits.prototype.getCircuitTuples = function getCircuitTuples() {
    var self = this;
    var tuples = [];
    var serviceNames = Object.keys(self.circuitsByServiceName);
    for (var index = 0; index < serviceNames.length; index++) {
        var serviceName = serviceNames[index];
        self.circuitsByServiceName[serviceName].collectCircuitTuples(tuples);
    }
    return tuples;
};

Circuits.prototype.getCircuitForRequest = function getCircuitForRequest(req) {
    var self = this;

    // Default the caller name.
    // All callers that fail to specifiy a cn share a circuit for each sn:en
    // and fail together.
    var callerName = req.headers.cn || 'no-cn';
    var serviceName = req.serviceName;
    if (!serviceName) {
        return new Result(new ErrorFrame('BadRequest', 'All requests must have a service name'));
    }

    var arg1 = String(req.arg1);
    var circuit = self.getCircuit(callerName, serviceName, arg1);

    if (!circuit.state.shouldRequest()) {
        return new Result(new ErrorFrame('Declined', 'Service is not healthy'));
    }

    return new Result(null, circuit);
};

function ErrorFrame(codeName, message) {
    this.codeName = codeName;
    this.message = message;
}

// Called upon membership change to collect services that the corresponding
// exit node is no longer responsible for.
Circuits.prototype.updateServices = function updateServices() {
    var self = this;
    var serviceNames = Object.keys(self.circuitsByServiceName);
    for (var index = 0; index < serviceNames.length; index++) {
        var serviceName = serviceNames[index];
        if (!self.egressNodes.isExitFor(serviceName)) {
            delete self.circuitsByServiceName[serviceName];
        }
    }
};

Circuits.prototype.emitCircuitStateChange = function emitCircuitStateChange(newStates, circuit) {
    var self = this;
    self.circuitStateChangeEvent.emit(
        self,
        new CircuitStateChange(circuit, newStates[0], newStates[1])
    );
};

function Circuit(callerName, serviceName, endpointName) {
    var self = this;
    EventEmitter.call(self);
    StateMachine.call(self);
    self.stateChangedEvent = self.defineEvent('stateChanged');
    self.callerName = callerName || 'no-cn';
    self.serviceName = serviceName;
    self.endpointName = endpointName;
    self.stateOptions = null;
}

inherits(Circuit, EventEmitter);

Circuit.prototype.setState = StateMachine.prototype.setState;

Circuit.prototype.extendLogInfo = function extendLogInfo(info) {
    var self = this;
    info.callerName = self.callerName;
    info.serviceName = self.serviceName;
    info.endpointName = self.endpointName;
    return info;
};

module.exports = Circuits;
