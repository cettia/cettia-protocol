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
var createWebSocketTransport = require("./transport-websocket-transport");
var createHttpStreamTransport = require("./transport-http-stream-transport");
var createHttpLongpollTransport = require("./transport-http-longpoll-transport");

// This function is exposed to the module's `open` as a factory to create a
// socket which establishes a connection to server.
module.exports = function(uri, options) {
    // A socket object representing the server.
    var self = new events.EventEmitter();
    // Prepares for `options` object to configure socket. It is passed to
    // transport factory so it can contain transport options as well.
    options = options || {};
    // A set of factories to create a transport. Given URI, each factory should
    // return a new transport object if the factory can handle that URI and
    // nothing if not. By modifying this option, user can write and use their
    // own transports and replace default transports with them.
    options.transports = options.transports || [createWebSocketTransport, createHttpStreamTransport, createHttpLongpollTransport];
    // A reference of transport associated with this socket.
    var transport;
    // Opens a connection by finding working transport and associating it with
    // the socket.
    self.open = function() {
        // If `uri` is a string, makes it array. FYI, `[].slice.call(uri)`
        // returns a copied `uri`.
        var uris = Array.isArray(uri) ? [].slice.call(uri) : [uri];
        // Translates abbreviated URIs into normal URIs. Then, the manipulated
        // `uris`'s each element corresponds to each transport.
        for (var i = 0; i < uris.length; i++) {
            var urlObj = url.parse(uris[i], true);
            delete urlObj.search;
            // URI whose scheme is `http` or `https` and `transport` param
            // doesn't exist is an abbreviated one. It should be translated into
            // three URIs corresponding to WebSocket, HTTP streaming and HTTP
            // long polling respectively. For example, if uri is
            // `http://localhost:8080/cettia`, it's replaced with
            if ((urlObj.protocol === "http:" || urlObj.protocol === "https:") && !urlObj.query.transport) {
                // `ws://localhost:8080/cettia`
                urlObj.protocol = urlObj.protocol.replace(/^http/, "ws");
                var uri1 = url.format(urlObj);
                // `http://localhost:8080/cettia?transport=stream`
                urlObj.query.transport = "stream";
                var uri2 = url.format(urlObj);
                // and `http://localhost:8080/cettia?transport=longpoll`.
                urlObj.query.transport = "longpoll";
                var uri3 = url.format(urlObj);
                // It means that replace `i+1`th element with `uri1`, `uri2` and
                // `uri3`. For example, `[1,2,3].splice(1,1,4,5,6)` results in
                // `[1,4,5,6,3]`.
                uris.splice(i, 1, uri1, uri2, uri3);
            }
        }
        // A temporary transport to be used while finding working transport.
        var trans;
        // Tries connection with next URI.
        function open() {
            // If there is no remaining URI, fires `error` and `close` event as
            // it means that all connection failed.
            if (uris.length === 0) {
                self.emit("error", new Error());
                self.emit("close");
                return;
            }
            // Removes the first element and returns it. For example,
            // `[1,2].shift()` returns `1` and make the array `[2]`.
            var uri = uris.shift();
            // Because transport can handle only the specific URI, URI
            // determines transport. It finds which transport can handle this
            // `uri` among transports specified by `transports` option.
            for (var i = 0; i < options.transports.length; i++) {
                // Each transport factory checks if the given URI can be handled
                // and creates and returns transport object if so and returns
                // nothing if not.
                trans = options.transports[i](uri, options);
                // If factory creates a transport,
                if (trans) {
                    // it establishes a connection.
                    trans.open();
                    // If it fails, it tries with next URI or other transport.
                    trans.on("close", open);
                    // If it succeeds, a process to find working transport is
                    // terminated. At the socket level, the first message is
                    // used to handshake the protocol. `once` registers one-time
                    // event handler.
                    trans.once("text", function(text) {
                        // The handshake output is in the form of URI and uses
                        // query part to get/set header.
                        var result = url.parse(text, true).query;
                        // To maintain alive connection, heartbeat is used.
                        options.heartbeat = +result.heartbeat;
                        // `_heartbeat` is usually for testing so it may be not
                        // passed from the server. The default value is `5000`.
                        options._heartbeat = +result._heartbeat || 5000;
                        // Now that the working transport is found and
                        // handshaking is completed, removes `close`
                        // event's `open` handler which is used to find working
                        // transport,
                        trans.removeListener("close", open);
                        // initializes the transport
                        init(trans);
                        // and fires `open` event which is the first event user
                        // can handle socket.
                        self.emit("open");
                    });
                    break;
                }
            }
        }
        // This is to stop the whole process to find a working transport when
        // the `close` method is before `open` event.
        function stop() {
            trans.removeListener("close", open);
            trans.close();
        }
        // Until socket is opened, `close` method should trigger `stop`
        // function as well.
        self.on("close", stop).on("open", function() {
            // If working transport is found, `stop` should be removed.
            self.removeListener("close", stop);
        });
        // Now that working transport is determined, associates it with the
        // socket.
        function init(trans) {
            // Assign `trans` to `transport` which is associated with the
            // socket.
            transport = trans;
            // When the transport has received a message from the server.
            transport.on("text", function(text) {
                // Converts JSON text to an event object.
                // 
                // It should have the following properties:
                // * `id: string`: an event identifier.
                // * `type: string`: an event type.
                // * `data: any`: an event data.
                // * `reply: boolean`: true if this event requires the reply.
                var event = JSON.parse(text);
                // If the server sends a plain event, dispatch it.
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
                    // Here, the controller is passed to the handler as 2nd
                    // argument and calls the server's `resolved` or `rejected`
                    // callback by sending `reply` event.
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
        }
        open();
        return this;
    };
    // Delegate closing to the transport.
    self.close = function() {
        if (transport) {
            // transport's close finally fires socket's close event too.
            transport.close();
        } else {
            // If this method is called while connecting to the server, `close`
            // event will execute the above `stop` function.
            self.emit("close");
        }
        return this;
    };
    // An id for event. It should be unique among events to be sent to the
    // server and has nothing to do with one the server sent.
    var eventId = 0;
    // A map for reply callbacks for reply.
    var callbacks = {};
    self.send = function(type, data, resolved, rejected) {
        if (!transport) {
            self.emit("error", new Error("notopened"));
            return this;
        }
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
    // Starts heartbeat on `open` event.
    self.on("open", function() {
        var heartbeatTimer;
        function setHeartbeatTimer() {
            // Sets a timer to send an `heartbeat` event after `heartbeat -
            // _heartbeat` miliseconds.
            heartbeatTimer = setTimeout(function() {
                self.send("heartbeat");
                // Sets a timer to fire heartbeat error and close the socket if
                // the server doesn't respond in the `_heartbeat` interval.
                heartbeatTimer = setTimeout(function() {
                    self.emit("error", new Error("heartbeat"));
                    self.close();
                }, options._heartbeat);
            }, options.heartbeat - options._heartbeat);
        }
        // If the server echoes back the sent `heartbeat` event, clears the
        // timer and set it again.
        self.on("heartbeat", function() {
            clearTimeout(heartbeatTimer);
            setHeartbeatTimer();
        });
        // The timer should be canceled on `close` event.
        self.on("close", function() {
            clearTimeout(heartbeatTimer);
        });
        setHeartbeatTimer();
    });
    return self.open();
};