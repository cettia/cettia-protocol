/*
 * Cettia
 * http://cettia.io/projects/cettia-protocol/
 * 
 * Copyright 2016 the original author or authors.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var url = require("url");
var http = require("http");
var createHttpBaseTransport = require("./transport-http-base-transport");

// This function is exposed to the module's `transport` module's `createHttpStreamTransport` as
// a factory to create a HTTP streaming transport. In streaming, the client performs a HTTP
// persistent connection and watches changes in response and the server prints chunk as message to
// response.
module.exports = function(uri, options) {
  var urlObj = url.parse(uri, true);
  // URI's protocol should be either `http` or `https` and transport param should be `stream`.
  if ((urlObj.protocol === "http:" || urlObj.protocol === "https:")
    && urlObj.query.transport === "stream") {
    // A transport object.
    var self = createHttpBaseTransport(uri, options);
    // Any error on request-response should propagate to transport.
    function onerror(error) {
      self.emit("error", error);
    }

    var req;
    self.connect = function() {
      // `close` event might be called twice
      var closed;
      // Performs a HTTP persistent connection through `GET` method. `when` param should be
      // `open`. In case of Server-Sent Events, `sse` param should be `true`.
      var reqOpts = url.parse(uri + "&when=open");
      // Somehow it's turned out that KeepAlive Agent is required on Node 4+.
      reqOpts.agent = new http.Agent({keepAlive: true});
      req = http.request(reqOpts)
      .on("error", onerror)
      // If the underlying connection of request-response was closed, fires `close` event.
      .on("close", function() {
        if (!closed) {
          closed = true;
          self.emit("close");
        }
      })
      .on("response", function(res) {
        // When to fire `open` event is a first message which is an output of handshaking not
        // when the response is available.
        var handshaked = false;
        // On a message of the event stream format of Server-Sent Events,
        function onmessage(data) {
          if (!handshaked) {
            handshaked = true;
            // The handshake output is in the form of URI.
            var result = url.parse(data, true).query;
            // A newly issued id for HTTP transport. It is used to identify which HTTP transport
            // is associated with which HTTP exchange.
            self.id = result.id;
            // And then fire `open` event.
            self.emit("open");
          } else {
            // `code` is a first character of a message and used to recognize that delivered
            // message is text message or binary message.
            var code = data.substring(0, 1);
            data = data.substring(1);
            switch (code) {
              // If the `code` is `1`, the remainder of message is a plain text message. Fires
              // `text` event.
              case "1":
                self.emit("text", data);
                break;
              // If the `code` is `2`, the remainder of message is a Base64-encoded binary
              // message. Decodes it in Base64 and fires `binary` event.
              case "2":
                self.emit("binary", new Buffer(data, "base64"));
                break;
              // Otherwise, it is invalid. Fires an error and closes the connection.
              default:
                self.emit("error", new Error("protocol"));
                self.close();
                break;
            }
          }
        }

        // Every chunk may be a single message, multiple messages or a fragment of a single
        // message. This buffer helps handle fragments.
        var buffer = "";
        // Chunks are formatted according to the [event stream
        // format](http://www.w3.org/TR/eventsource/#event-stream-interpretation). However, you
        // don't need to know that. A single message starts with 'data: ' and ends with `\n\n`.
        // That's all you need to know.
        res.on("error", onerror).on("data", function(chunk) {
          // Strips off the left padding of the chunk that appears in the first chunk.
          chunk = chunk.toString().replace(/^\s+/, "");
          // If the chunk consists of only whitespace characters that is the first chunk padding
          // in the above, there is nothing to do.
          if (!chunk) {
            return;
          }
          // Let's think of a series of the following chunks:
          // * `"data: {}\n\ndata: {}\n\n"`
          // * `"data: {}\n\ndata: {"`
          // * `"}\n\ndata:{"`
          // * `".."`
          // * `".}"`
          // * `"\n\ndata: {}\n\n"`
          //
          // It looks not easy to handle. So let's concatenate buffer
          // and chunk. Here the buffer is a string after last `\n\n`
          // of the concatenation.
          // * `""` + `"data: {}\n\ndata: {}\n\n"`
          // * `""` + `"data: {}\n\ndata: {"`
          // * `"data: {"` + `"}\n\ndata:{"`
          // * `"data: {"` + `".."`
          // * `"data: {.."` + `".}"`
          // * `"data: {...}"` + `"\n\ndata: {}\n\n"`

          // Let's split the concatenation by `\n\n`.
          (buffer + chunk).split("\n\n").forEach(function(line, i, lines) {
            // Except the last element, unwraps 'data: ' and fires a message event.
            if (i < lines.length - 1) {
              onmessage(line.substring("data: ".length));
            } else {
              // The last element is a fragment of a data which is an incomplete message.
              // Assigns it to buffer.
              buffer = line;
            }
          });
        })
        // The end of response corresponds to the close of transport.
        .on("end", function() {
          if (!closed) {
            closed = true;
            self.emit("close");
          }
        });
      });
      req.end();
    };
    self.abort = function() {
      // Aborts the current request. The rest of work, firing the `close` event, will be done by
      // `res`'s `end` event handler.
      req.abort();
    };
    return self;
  }
};
