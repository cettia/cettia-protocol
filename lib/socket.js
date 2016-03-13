/*
 * Cettia
 * http://cettia.io/projects/cettia-protocol/
 * 
 * Copyright 2015 the original author or authors.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var url = require("url");
var msgpack = require("msgpack-lite");
var traverse = require("traverse");
var createWebSocketTransport = require("./transport-websocket-transport");
var createHttpStreamTransport = require("./transport-http-stream-transport");
var createHttpLongpollTransport = require("./transport-http-longpoll-transport");

// This function is exposed to the module's `open` as a factory to create a socket which
// establishes a connection to server.
module.exports = function(uri, options) {
  // A socket object representing the server.
  var self = new events.EventEmitter();
  // As the state of the socket, it can be one of the following values: `connecting`, `opened`,
  // `closed` and `waiting`.
  self.state = null;
  // Prepares for `options` object to configure socket as well as transport.
  options = options || {};
  // A set of factories to create a transport. Given URI, each factory should return a new
  // transport object if the factory can handle that URI and nothing if not. By modifying this
  // option, user can write and use their own transports and replace default transports with them.
  options.transports = options.transports ||
    [createWebSocketTransport, createHttpStreamTransport, createHttpLongpollTransport];
  // A function to determine whether or not to reconnect. It is called every time after the
  // `close` event with the last delay in milliseconds used or null at first and the total
  // number of reconnection attempts. It should return a reconnection delay in milliseconds. A
  // boolean value of `false` or a function returning `false` stand for no reconnection.
  options.reconnect = options.reconnect || false;

  // An identifier of the socket.
  var id;
  // A transport associated with the socket.
  var transport;
  // A set of variables related to reconnection.
  var reconnectTimer;
  var reconnectDelay;
  var reconnectTry = 0;
  // Opens a socket.
  self.open = function() {
    // Resets the previous transport.
    transport = null;
    // Because a user might execute this method by force for some reason, it shouldn't conflict
    // with the already scheduled reconnection. It cancels the reconnection timer.
    clearTimeout(reconnectTimer);
    // Fires the `connecting` event that is the first socket event that user can handle after a
    // little while to give a user a chance to add other event handlers.
    setTimeout(function() {
      self.emit("connecting");
    }, 0);
    return this;
  };
  // Closes the socket.
  self.close = function() {
    // Prevents further reconnection by setting `reconnect` option to `false`.
    options.reconnect = false;
    // Cancels the scheduled reconnection as well.
    clearTimeout(reconnectTimer);
    // If it's connecting to the server,
    if (self.state === "connecting") {
      // The `stop` function declared in the below `connecting` event handler should run. As it
      // is registered as `close` event handler, firing `close` event will execute `stop` function.
      self.emit("close");
      // If there is active connection,
    } else if (self.state === "opened") {
      // Closes it which will fire socket's `close` event finally.
      transport.close();
    }
    return this;
  };
  // Finds a working transport and establishes a connection on `connecting` event.
  self.on("connecting", function() {
    // Transition to `connecting` state. It transitions to `opened` state if a connection is
    // established successfully or `closed` state if a connection couldn't be established.
    self.state = "connecting";
    // If `uri` is a string, makes it array. FYI, `[].slice.call(uri)` returns a copied array of
    // `uri`.
    var uris = Array.isArray(uri) ? [].slice.call(uri) : [uri];
    // Translates abbreviated URIs into normal URIs and attaches `id` if it exits. Then, the
    // manipulated `uris`'s each element corresponds to each transport.
    for (var i = 0; i < uris.length; i++) {
      var urlObj = url.parse(uris[i], true);
      delete urlObj.search;
      // If the socket id exists, attaches it to query under the name of `sid`.
      if (id) {
        urlObj.query.sid = id;
      }
      // URI whose scheme is `http` or `https` and `transport` param doesn't exist is an
      // abbreviated one. It should be translated into three URIs corresponding to WebSocket,
      // HTTP streaming and HTTP long polling respectively. For example, if uri is
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
        // It means that replace `i+1`th element with `uri1`, `uri2` and `uri3`. For example,
        // `[1,2,3].splice(1,1,4,5,6)` results in `[1,4,5,6,3]`.
        uris.splice(i, 1, uri1, uri2, uri3);
      } else {
        // FYI, it equals to `uris.splice(i, 1, url.format(urlObj))`.
        uris[i] = url.format(urlObj);
      }
    }

    // Starts a process to find a working transport.
    function find() {
      // If there is no remaining URI, fires `error` and `close` event as it means that all
      // tries failed.
      if (uris.length === 0) {
        // Now that `connecting` event is being fired, if `error` and `close` event is fired,
        // user's `error` and `close` event handlers are always prior to user's `connecting` event
        // handler. As it is nonsense, delay to fire them a little while.
        setTimeout(function() {
          self.emit("error", new Error());
          self.emit("close");
        }, 0);
        return;
      }
      // A temporal variable to be used while finding working one.
      var testTransport;
      // Get the first uri by removing it from `uris`. For example, `[1,2].shift()` returns `1`
      // and make the array `[2]`.
      var uri = uris.shift();
      // Because transport handles only the specific URI, URI determines transport. It finds
      // which transport factory can handle this `uri` among transport factories specified by
      // `transports` option.
      for (var i = 0; i < options.transports.length; i++) {
        // A transport factory creates and returns transport object if it can handle the given
        // URI and nothing if not.
        testTransport = options.transports[i](uri, options);
        // If the factory handles this type of URI,
        if (testTransport) {
          break;
        }
      }
      // If there is no transport matching with the given URI, try a connection with the next URI.
      if (!testTransport) {
        find();
        return;
      }
      // This is to stop the whole process to find a working transport when the `close` method
      // is called before `open` event.
      function stop() {
        testTransport.removeListener("close", find);
        testTransport.close();
      }

      // Until the socket is opened, `close` method should trigger `stop` function as well.
      self.once("close", stop);
      // it establishes a connection.
      testTransport.open();
      // If it fails, it should remove stop listener and try a connection with the next URI.
      testTransport.on("close", function() {
        self.removeListener("close", stop);
      });
      testTransport.on("close", find);
      // Node.js kills the process by default when an `error` event is fired if there is no
      // listener for it. However, a user doesn't need to be notified of an error from this
      // transport until it is recognized as a working transport as it is a part of a process to
      // find a working transport.
      testTransport.on("error", function() {
      });
      // If it succeeds, a process to find working transport is terminated. The first transport
      // text message is used to handshake the socket protocol. Note that `once` registers
      // one-time event handler.
      testTransport.once("text", function(text) {
        // The handshake output is in the form of URI and uses query part to represent protocol
        // header.
        var headers = url.parse(text, true).query;
        // The server prints an id of the socket as a protocol header under the name of `sid`
        // every time transport connects. If the server issues a new id,
        if (id !== headers.sid) {
          // That means there was no `id` or the server socket whose id is `id` was deleted in
          // the server due to long-term disconnection.
          id = headers.sid;
          // Fires a `new` event as a new socket is created.
          self.emit("new");
        }

        // To maintain an alive connection, `heartbeat` is used.
        options.heartbeat = +headers.heartbeat;
        // `_heartbeat` is usually for testing so it may be not passed from the server. The
        // default value is `5000`.
        options._heartbeat = +headers._heartbeat || 5000;
        // Now that the working transport is found and handshaking is completed, it removes
        // `close` event handler `find`.
        testTransport.removeListener("close", find);
        // Associates the working transport with the socket.
        transport = testTransport;

        // When an event object is created from `text` or `binary` event.
        function onevent(event) {
          // Event should have the following properties:
          // * `id: string`: an event identifier.
          // * `type: string`: an event type.
          // * `data: any`: an event data.
          // * `reply: boolean`: `true` if this event requires the reply.
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

            // Here, the controller is passed to the handler as 2nd argument and calls the
            // server's `resolved` or `rejected` callback by sending `reply` event.
            self.emit(event.type, event.data, {resolve: reply(true), reject: reply(false)});
          }
        }

        // When the transport has received a text message from the server.
        transport.on("text", function(text) {
          // By default, text message is JSON text representing an event object.
          onevent(JSON.parse(text));
        });
        // When the transport has received a binary message from the server.
        transport.on("binary", function(binary) {
          // By default, binary message is [MessagePack](http://msgpack.org) buffer representing
          // an event object.
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
        // Removes `close` event handler `stop` and fires `open` event.
        self.removeListener("close", stop);
        self.emit("open");
      });
    }

    find();
  });
  // Starts heartbeat on `open` event.
  self.on("open", function() {
    // Transition to `opened` state. It transitions to `closed` state if a connection is closed
    // for some reason.
    self.state = "opened";
    var heartbeatTimer;

    function setHeartbeatTimer() {
      // Sets a timer to send an `heartbeat` event after `heartbeat - _heartbeat` milliseconds.
      heartbeatTimer = setTimeout(function() {
        self.send("heartbeat");
        // If the server echoes back the sent `heartbeat` event, clears the timer and set it again.
        self.once("heartbeat", function() {
          clearTimeout(heartbeatTimer);
          setHeartbeatTimer();
        });
        // Sets a timer to fire a heartbeat error and close the connection if the server doesn't
        // respond in the `_heartbeat` milliseconds.
        heartbeatTimer = setTimeout(function() {
          self.emit("error", new Error("heartbeat"));
          transport.close();
        }, options._heartbeat);
      }, options.heartbeat - options._heartbeat);
    }

    // The timer should be canceled on `close` event.
    self.once("close", function() {
      clearTimeout(heartbeatTimer);
    });
    setHeartbeatTimer();
    // Resets a set of variables related to reconnection.
    reconnectTimer = reconnectDelay = null;
    reconnectTry = 0;
  });
  // Schedules reconnection on `close` event.
  self.on("close", function() {
    // Transition to `closed` state. It transitions to `waiting` state if reconnection is scheduled.
    self.state = "closed";
    if (options.reconnect) {
      // Gives a user a chance to handle `close` event before firing `waiting` event.
      setTimeout(function() {
        // Determines whether to schedule reconnection by providing the last reconnection delay
        // and the total number of reconnection attempts to `reconnect` option.
        reconnectDelay = options.reconnect.call(self, reconnectDelay, reconnectTry);
        // If the returned value is not `false`, schedules a reconnection timer.
        if (reconnectDelay !== false) {
          // Increments the number of reconnection attempts.
          reconnectTry++;
          reconnectTimer = setTimeout(function() {
            self.open();
          }, reconnectDelay);
          // Fires `waiting` event with information about scheduled reconnection - a time to
          // wait for reconnection and the number of attempts.
          self.emit("waiting", reconnectDelay, reconnectTry);
        }
      }, 0);
    }
  });
  self.on("waiting", function(delay, attempts) {
    // Transition to `waiting` state. It transitions to `connecting` state after `delay`
    // milliseconds.
    self.state = "waiting";
  });

  // An event id. It should be unique among events to be sent to the server and has nothing to
  // do with one the server sent.
  var eventId = 0;
  // A map for reply callbacks.
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
      // * `reply: boolean`: `true` if this event requires the reply.
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
      // the given data is binary, it can't be serialized by JSON.
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

  // Opens a socket to the server.
  return self.open();
};
