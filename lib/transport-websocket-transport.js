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
var WebSocket = require("ws");
var createBaseTransport = require("./transport-base-transport");

// This function is exposed to the module's `transport` module's
// `createWebSocketTransport` as a factory to create a WebSocket transport.
// WebSocket is a protocol designed for a full-duplex communications over a TCP
// connection.
module.exports = function(uri, options) {
    var urlObj = url.parse(uri, true);
    // URI's protocol should be either `ws` or `wss`.
    if (urlObj.protocol === "ws:" || urlObj.protocol === "wss:") {
        // A transport object.
        var self = createBaseTransport(uri, options);
        var ws;
        self.connect = function() {
            // Simply delegates WebSocket's events to transport and transport's
            // behaviors to WebSocket.
            ws = new WebSocket(uri);
            ws.onopen = function() {
                self.emit("open");
            };
            ws.onmessage = function(event) {
                // `event.data` is a message. It is string if text frame is sent and
                // Buffer if binary frame is sent.
                if (typeof event.data === "string") {
                    self.emit("text", event.data);
                } else {
                    self.emit("binary", event.data);
                }
            };
            ws.onerror = function(error) {
                self.emit("error", error);
            };
            ws.onclose = function() {
                self.emit("close");
            };
        };
        self.write = function(data) {
            // If `data` is string, a text frame is sent, and if it's Buffer, a
            // binary frame is sent.
            ws.send(data);
        };
        self.close = function() {
            ws.close();
            return this;
        };
        return self;
    }
};