/*
 * Cettia
 * http://cettia.io/projects/cettia-protocol/
 * 
 * Copyright 2016 the original author or authors.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var WebSocket = require("ws");

// This function is exposed to the module's `transport` module's `createWebSocketServer` as a
// factory to create server which consumes WebSocket connection and produces transport.
module.exports = function() {
  // A transport server object.
  var self = new events.EventEmitter();
  // A factory to upgrade HTTP exchange to WebSocket.
  var webSocketUpgrader = new WebSocket.Server({noServer: true});
  // A link between Cettia WebSocket transport protocol and Node.js. `req`, `sock` and `head`
  // are expected to be passed from Node.js's `http/https` module' server' `upgrade` event.
  self.handle = function(req, sock, head) {
    webSocketUpgrader.handleUpgrade(req, sock, head, function(ws) {
      self.emit("transport", createWebSocketTransport(ws));
    });
  };
  return self;
};

// WebSocket is a protocol designed for a full-duplex communications over a TCP connection.
function createWebSocketTransport(ws) {
  // A transport object.
  var self = new events.EventEmitter();
  // Transport URI contains information like protocol header as query.
  self.uri = ws.upgradeReq.url;
  // Simply delegates WebSocket's events to transport and transport's behaviors to WebSocket.
  ws.onmessage = function(event) {
    // `event.data` is a message. It is string if text frame is sent and Buffer if binary frame
    // is sent.
    if (typeof event.data === "string") {
      self.emit("text", event.data);
    } else {
      self.emit("binary", event.data);
    }
  };
  ws.onerror = function(error) {
    self.emit("error", error);
  };
  // A flag to check the transport is opened.
  var opened = true;
  ws.onclose = function() {
    opened = false;
    self.emit("close");
  };
  self.send = function(data) {
    // Allows to send data only it is opened. If not, fires an error.
    if (opened) {
      // If `data` is string, a text frame is sent, and if it's Buffer, a binary frame is sent.
      ws.send(data);
    } else {
      self.emit("error", new Error("notopened"));
    }
    return this;
  };
  self.close = function() {
    ws.close();
    return this;
  };
  return self;
}
