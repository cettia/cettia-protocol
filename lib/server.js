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
var uuid = require("node-uuid");

// This function is exposed to the module's `createServer` as a factory to
// create a server which consumes transport and produces socket.
module.exports = function() {
    // A server object.
    var self = new events.EventEmitter();
    // A repository of sockets consisting of opened socket and closed socket
    // only. A socket has id but it doesn't need to be public now so that array
    // is used to hide it.
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
        var socket;
        // A transport's URI's query represents protocol header.
        var headers = url.parse(transport.uri, true).query;
        // If it attaches a socket id, looks up a socket whose id is the given
        // id from the repository.
        if (headers.sid) {
            for (var i = 0; i < self.sockets.length; i++) {
                // There may be no matching socket if a socket whose id is the
                // given id was deleted due to long-term disconnection.
                if (self.sockets[i].id === headers.sid) {
                    socket = self.sockets[i];
                    // Injects a new transport to socket.
                    socket.handshake(transport);
                    break;
                }
            }
        }
        if (!socket) {
            // Creates a socket.
            socket = createSocket(options);
            // If the handshake is performed successfully, adds the socket to
            // the repository and has it removed when it is deleted. It should
            // be done before giving user a chance to add their `open` event
            // handler.
            socket.on("open", function() {
                self.sockets.push(socket);
                socket.on("delete", function() {
                    // It equals to `self.sockets.remove(socket)`.
                    self.sockets.splice(self.sockets.indexOf(socket), 1);
                });
            });
            // Fires `socket` event to server to give user a chance to add their
            // event handlers.
            self.emit("socket", socket);
            // Performs the handshake by injecting a transport.
            socket.handshake(transport);
        }
    };
    return self;
};

function createSocket(options) {
    // A socket object representing the client.
    var self = new events.EventEmitter();
    // As the state of the socket, it can be one of the following values:
    // `opened`, `closed` and `deleted`.
    self.state = null;

    // An identifier of the socket.
    var id = uuid.v4();
    // Exposes it for comparison but it's not necessary.
    self.id = id;
    // A transport associated with the socket.
    var transport;
    // Performs the handshake.
    self.handshake = function(trans) {
        // Associates the given transport with the socket.
        transport = trans;
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
                // Here, the controller is passed to the handler as 2nd argument
                // and calls the server's `resolved` or `rejected` callback by
                // sending `reply` event.
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
        // Aggregates id, heartbeat and _heartbeat, makes URI from them, sends
        // it as the first message of transport. A client socket will fire
        // `open` event.
        transport.send(url.format({query: {sid: id, heartbeat: options.heartbeat, _heartbeat: options._heartbeat}}));
        // As it is possible to exchange events now, fires `open` event.
        self.emit("open");
        return this;
    };
    // A timer to transition to `deleted` state.
    var deleteTimer;
    self.on("open", function() {
        // Transition to `opened` state. It transitions to `closed` state if a
        // connection is closed for some reason.
        self.state = "opened";
        // Sets a heartbeat timer to close the socket after the `heartbeat`
        // interval.
        var heartbeatTimer;
        function setHeartbeatTimer() {
            heartbeatTimer = setTimeout(function() {
                self.emit("error", new Error("heartbeat"));
                // It must close transport not socket.
                transport.close();
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
        });
        // To prevent a side effect of the timer, clears it on the close event.
        self.on("close", function() {
            clearTimeout(heartbeatTimer);
        });
        // Resets the delete timer.
        clearTimeout(deleteTimer);
    });
    self.on("close", function() {
        // Transition to `closed` state. It transitions to `opened` state if
        // a connection is established again again within 1 min or `deleted`
        // state if not.
        self.state = "closed";
        deleteTimer = setTimeout(function() {
            // Transition to `deleted` state. It's the end of the socket.
            self.state = "deleted";
            // Fires a `delete` event as this socket ends.
            self.emit("delete");
        }, 60 * 1000);
    });
    // An id for event. It should be unique among events to be sent to the
    // client and has nothing to do with one the client sent.
    var eventId = 0;
    // A map for reply callbacks for reply.
    var callbacks = {};
    self.send = function(type, data, resolved, rejected) {
        // If it's not able to send event, fires `cache` event with arguments.
        if (self.state !== "opened") {
            self.emit("cache", [type, data, resolved, rejected]);
        } else {
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
        }
        return this;
    };
    // Delegate closing to the transport.
    self.close = function() {
        // If there is active connection,
        if (self.state === "opened") {
            // Closes it which will fire socket's `close` event finally.
            transport.close();
        } else {
            // If not, it doesn't need to wait for the delete timer to expire.
            // Regards the socket as `deleted` immediately.
            clearTimeout(deleteTimer);
            self.state = "deleted";
            self.emit("delete");
        }
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
    return self;
}