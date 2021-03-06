/*
 * Cettia
 * http://cettia.io/projects/cettia-protocol/
 * 
 * Copyright 2017 the original author or authors.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var url = require("url");
var uuid = require("uuid");
var msgpack = require("msgpack-lite");
var traverse = require("traverse");

// This function is exposed to the module's `createServer` as a factory to create a server which
// consumes transport and produces socket.
module.exports = function() {
  // A server object.
  var self = new events.EventEmitter();
  // A repository of sockets consisting of opened socket and closed socket only. A socket has id
  // but it doesn't need to be public now so that array is used to hide it.
  self.sockets = [];
  // Options to configure server and client.
  var options = {
    // A heartbeat interval in milliseconds.
    heartbeat: 20000,
    // This is just to speed up heartbeat test and should not work in production. It means the time
    // to wait for this server's response. The default value is `5000`.
    _heartbeat: 5000
  };
  self.setHeartbeat = function(heartbeat) {
    options.heartbeat = +heartbeat;
  };
  self.set_heartbeat = function(_heartbeat) {
    options._heartbeat = +_heartbeat;
  };
  // A link between Cettia protocol and Cettia transport protocol. `transport` is expected to be
  // passed from Cettia transport server.
  self.handle = function(transport) {
    var socket;
    // Query params starting with `cettia-` represent protocol header.
    var headers = url.parse(transport.uri, true).query;
    // If it attaches a socket id, looks up the corresponding socket from the repository.
    if (headers["cettia-id"]) {
      for (var i = 0; i < self.sockets.length; i++) {
        // There may be no matching socket if a socket whose id is the given id was deleted due
        // to long-term disconnection.
        if (self.sockets[i].id === headers["cettia-id"]) {
          socket = self.sockets[i];
          break;
        }
      }
    }
    if (!socket) {
      // Creates a socket.
      socket = createSocket(options);
      // If the handshake is performed successfully, adds the socket to the repository and has
      // it removed when it is deleted. It should be done before giving user a chance to add
      // their `open` event handler and only once.
      socket.once("open", function() {
        self.sockets.push(socket);
        socket.on("delete", function() {
          // It equals to `self.sockets.remove(socket)`.
          self.sockets.splice(self.sockets.indexOf(socket), 1);
        });
      });
      // Fires `socket` event to server to give user a chance to add their event handlers.
      self.emit("socket", socket);
    }
    // Performs the handshake by injecting a transport.
    socket.handshake(transport);
  };
  return self;
};

function createSocket(options) {
  // A socket object representing the client.
  var self = new events.EventEmitter();
  // As the state of the socket, it can be one of the following values: `opened`, `closed` and
  // `deleted`.
  self.state = null;

  // Issues an identifier of the socket.
  var id = uuid.v4();
  // Exposes it for comparison but it's not necessary.
  self.id = id;
  // A transport associated with the socket.
  var transport;
  // Performs the handshake.
  self.handshake = function(t) {
    function handshake() {
      // Associates the given transport with the socket.
      transport = t;

      // When an event object is created from `text` or `binary` event.
      function onevent(event) {
        // Event should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // * `reply: boolean`: true if this event requires the reply.

        // If the client sends a plain event, dispatch it.
        if (!event.reply) {
          self.emit(event.type, event.data);
        } else {
          var latch;
          // A function to create a function.
          function reply(success) {
            // A controller function.
            return function(value) {
              // This latch prevents double reply.
              if (!latch) {
                latch = true;
                self.send("reply", {id: event.id, data: value, exception: !success});
              }
            };
          }

          // Here, the controller is passed to the event handler as 2nd argument and allows
          // to call the server's `resolved` or `rejected` callback by sending `reply` event.
          self.emit(event.type, event.data, {resolve: reply(true), reject: reply(false)});
        }
      }

      // When the transport has received a text message from the client,
      // it deserializes a text message into an event object in the JSON format and deals with it.
      transport.on("text", function(text) {
        onevent(JSON.parse(text));
      });
      // When the transport has received a binary message from the server.
      // it deserializes a binary message into an event object in the
      // [MessagePack](http://msgpack.org) format and deals with it.
      transport.on("binary", function(binary) {
        onevent(msgpack.decode(binary));
      });
      // When any error has occurred.
      transport.on("error", function(error) {
        self.emit("error", error);
      });
      // When the transport has been closed for any reason.
      transport.on("close", function() {
        self.emit("close");
      });
      // Aggregates `id`, `heartbeat` and `_heartbeat` header, makes URI from them,
      // sends it as the first message of transport. A client socket will fire `open` event.
      transport.send(url.format({
        query: {
          // This value should be calculated through protocol version the client implemented.
          // However, now that `1.0` is the only version, we don't need to do that.
          "cettia-version": "1.0",
          "cettia-id": id,
          "cettia-heartbeat": options.heartbeat,
          "cettia-_heartbeat": options._heartbeat
        }
      }));
      // As it is possible to exchange events now, fires `open` event.
      self.emit("open");
    }

    // The underlying transport might be alive.
    if (self.state === "opened") {
      // If so, closes the transport to make sure there is no connection leak and make the
      // handshake to be performed on `close` event.
      transport.on("close", handshake);
      transport.close();
    } else {
      // If not, performs the handshake immediately.
      handshake();
    }
    return this;
  };
  // A timer to close the socket after the `heartbeat` interval.
  var heartbeatTimer;

  function setHeartbeatTimer() {
    heartbeatTimer = setTimeout(function() {
      self.emit("error", new Error("heartbeat"));
      // It must close the transport not the socket.
      transport.close();
    }, options.heartbeat);
  }

  // A timer to transition to `deleted` state.
  var deleteTimer;
  self.on("open", function() {
    // Transition to `opened` state. It transitions to `closed` state if a connection is closed
    // for some reason.
    self.state = "opened";
    // Sets a heartbeat timer.
    setHeartbeatTimer();
    // Resets the delete timer.
    clearTimeout(deleteTimer);
  });
  // The client will start to heartbeat on its `open` event and send the heartbeat event
  // periodically.
  self.on("heartbeat", function() {
    // Then, cancels the timer, sets it up again and sends the heartbeat event as a response.
    clearTimeout(heartbeatTimer);
    setHeartbeatTimer();
    self.send("heartbeat");
  });
  self.on("close", function() {
    // Transition to `closed` state. It transitions to `opened` state if a connection is
    // established by the client again within 1 min.
    // Otherwise, it transitions to `deleted` state.
    self.state = "closed";
    // Resets the heartbeat timer.
    clearTimeout(heartbeatTimer);
    deleteTimer = setTimeout(function() {
      // Fires a `delete` event as this socket ends.
      self.emit("delete");
    }, 60 * 1000);
  });
  self.on("delete", function() {
    // Transition to `deleted` state. It's the end of the socket.
    self.state = "deleted";
  });
  // An id for event. It should be unique among events to be sent to the client and has nothing
  // to do with one the client sent.
  var eventId = 0;
  // A map for reply callbacks for reply.
  var callbacks = {};
  self.send = function(type, data, resolved, rejected) {
    // If it's not able to send event, fires `cache` event with arguments.
    if (self.state !== "opened") {
      self.emit("cache", [type, data, resolved, rejected]);
    } else {
      // Event should have the following properties:
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
      // Traverses the given data to check if it contains binary. Even if one of properties of
      // the given data is binary, it can't be serialized in JSON.
      var hasBinary = traverse(data).reduce(function(hasBuffer, e) {
        return hasBuffer || Buffer.isBuffer(e) || ArrayBuffer.isView(e);
      }, false);
      // If the given data contains binary, serializes an event object to
      // [MessagePack](http://msgpack.org). Otherwise, use JSON.
      var message = hasBinary ? msgpack.encode(event) : JSON.stringify(event);
      // Sends the message through the transport.
      transport.send(message);
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
      // If not, it doesn't need to wait for the delete timer to expire. Regards the socket as
      // `deleted` immediately.
      clearTimeout(deleteTimer);
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
