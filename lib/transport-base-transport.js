/*
 * Cettia
 * http://cettia.io/projects/cettia-protocol/
 * 
 * Copyright 2016 the original author or authors.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");

// It creates a base transport.
module.exports = function(uri, options) {
  // A transport timeout in ms. It applies when a transport starts connection.
  var timeout = options && options.timeout || 3000;
  // A transport object.
  var self = new events.EventEmitter();
  self.open = function() {
    // Establishes the real connection. `connect` should be implemented by others.
    self.connect(uri, options);
    // Sets a timeout timer.
    var timeoutTimer = setTimeout(function() {
      // Fires a timeout error.
      self.emit("error", new Error("timeout"));
      // `close` should ensure that `close` event is fired.
      self.close();
    }, timeout);
    // If it establishes a connection, cancels the timer.
    self.on("open", function() {
      clearTimeout(timeoutTimer);
    });
    // If it fails to establish a connection before the timer expires,
    // cancels the timer.
    self.on("close", function() {
      clearTimeout(timeoutTimer);
    });
    return this;
  };
  // A flag to check the transport is opened.
  self.opened = false;
  self.on("open", function() {
    self.opened = true;
  });
  self.on("close", function() {
    self.opened = false;
  });
  self.send = function(data) {
    // Allows to send data only it is opened. If not, fires an error.
    if (self.opened) {
      self.write(data);
    } else {
      self.emit("error", new Error("notopened"));
    }
    return this;
  };
  return self;
};
