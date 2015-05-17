/*
 * Cettia
 * http://cettia.io/projects/cettia-protocol/
 * 
 * Copyright 2015 The Cettia Project
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var url = require("url");

// This function is exposed to the module's `createServer` as a factory to
// create a server which consumes transport and produces socket.
module.exports = function() {
    // A server object.
    var self = new events.EventEmitter();
    // A repository of sockets consisting of opened socket and closed socket
    // only. A socket has id but it doesn't need to be public now so that array
    // is used to hide it. TODO
    self.sockets = [];
    // Options to configure server and client.
    var options = {
        // A heartbeat interval in milliseconds.
        heartbeat: 20000,
        // This is just to speed up heartbeat test and not required generally.
        // It means the time to wait for the server's response. The default
        // value is `5000`.
        _heartbeat: 5000
    };
    self.setHeartbeat = function(heartbeat) {
        options.heartbeat = +heartbeat;
    };
    self.set_heartbeat = function(_heartbeat) {
        options._heartbeat = +_heartbeat;
    };
    // A link between Cettia protocol and Cettia transport protocol. `transport` is
    // expected to be passed from Cettia transport server.
    self.handle = function(transport) {
        // Builds a socket on top of a transport
        var socket = createSocket(transport, options);
        // TODO
        self.sockets.push(socket);
        socket.on("close", function() {
            // It equals to `self.sockets.remove(socket)`.
            self.sockets.splice(self.sockets.indexOf(socket), 1);
        });
        // Fires `socket` event to server. This is the beginning of the socket
        // life cycle.
        self.emit("socket", socket);
    };
    return self;
};

function createSocket(transport, options) {
    // A socket object representing the client.
    var self = new events.EventEmitter();
    // When the transport has received a message from the client.
    transport.on("text", function(text) {
        // Converts JSON text to an event object.
        // 
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // * `reply: boolean`: true if this event requires the reply.
        var event = JSON.parse(text);
        // If the client sends a plain event, dispatch it.
        if (!event.reply) {
            self.emit(event.type, event.data);
        } else {
            var latch;
            // A function to create a function. 
            function reply(success) {
                // A controller function.
                return function(value) {
                    // The latch prevents double reply.
                    if (!latch) {
                        latch = true;
                        self.send("reply", {id: event.id, data: value, exception: !success});
                    }
                };
            }
            // Here, the controller is passed to the handler as 2nd argument and
            // calls the server's `resolved` or `rejected` callback by sending
            // `reply` event.
            self.emit(event.type, event.data, {resolve: reply(true), reject: reply(false)});
        }
    });
    // When any error has occurred.
    transport.on("error", function(error) {
        self.emit("error", error);
    });
    // When the transport has been closed for any reason.
    transport.on("close", function() {
        self.emit("close");
    });
    // An id for event. It should be unique among events to be sent to the
    // client and has nothing to do with one the client sent.
    var eventId = 0;
    // A map for reply callbacks for reply.
    var callbacks = {};
    self.send = function(type, data, resolved, rejected) {
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // * `reply: boolean`: true if this event requires the reply.
        var event = {
            id: "" + eventId++, 
            type: type, 
            data: data, 
            reply: resolved != null || rejected != null
        };
        // Stores resolved and rejected callbacks if they are given.
        if (event.reply) {
            callbacks[event.id] = {resolved: resolved, rejected: rejected};
        }
        // Convert the event to a JSON message and sends it through the
        // transport.
        transport.send(JSON.stringify(event));
        return this;
    };
    // Delegate closing to the transport.
    self.close = function() {
        transport.close();
        return this;
    };
    // On the `reply` event, executes the stored reply callbacks with data.
    self.on("reply", function(reply) {
        if (reply.id in callbacks) {
            var cbs = callbacks[reply.id];
            var fn = reply.exception ? cbs.rejected : cbs.resolved;
            if (fn) {
                fn.call(this, reply.data);
            }
            delete callbacks[reply.id];
        }
    });
    // Sets a timer to close the socket after the heartbeat interval.
    var heartbeatTimer;
    function setHeartbeatTimer() {
        heartbeatTimer = setTimeout(function() {
            self.emit("error", new Error("heartbeat"));
            self.close();
        }, options.heartbeat);
    }
    setHeartbeatTimer();
    // The client will start to heartbeat on its `open` event and send the
    // heartbaet event periodically. Then, cancels the timer, sets it up
    // again and sends the heartbeat event as a response.
    self.on("heartbeat", function() {
        clearTimeout(heartbeatTimer);
        setHeartbeatTimer();
        self.send("heartbeat");
    })
    // To prevent a side effect of the timer, clears it on the close event.
    .on("close", function() {
        clearTimeout(heartbeatTimer);
    });
    // Starts handshake for the protocol. These params will be handled by
    // client-side socket, and client-side socket will fire `open` event. The
    // first message of transport is used to perform handshaking and should be
    // formatted in URI.
    transport.send(url.format({query: {heartbeat: options.heartbeat, _heartbeat: options._heartbeat}}));
    return self;
}