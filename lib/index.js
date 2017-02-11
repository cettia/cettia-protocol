/*
 * Cettia
 * http://cettia.io/projects/cettia-protocol/
 * 
 * Copyright 2016 the original author or authors.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
// Defines the Cettia module.
module.exports = {
  // Creates a Cettia socket and establishes a connection to the server.
  open: require("./socket"),
  // Creates a Cettia server.
  createServer: require("./server"),
  // Defines the Cettia transport module.
  transport: {
    // Creates a HTTP transport server.
    createHttpServer: require("./transport-http-server"),
    // Creates a HTTP streaming transport.
    createHttpStreamTransport: require("./transport-http-stream-transport"),
    // Creates a HTTP long polling transport.
    createHttpLongpollTransport: require("./transport-http-longpoll-transport"),
    // Creates a WebSocket transport server.
    createWebSocketServer: require("./transport-websocket-server"),
    // Creates a WebSocket transport.
    createWebSocketTransport: require("./transport-websocket-transport")
  }
};
