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
var http = require("http");
var createBaseTransport = require("./transport-base-transport");

http.globalAgent.maxSockets = Infinity;

// It creates a base transport which provides common functionalities of HTTP
// transport.
module.exports = function(uri, options) {
    // A transport object.
    var self = createBaseTransport(uri, options);
    // A flag to mark the transport is sending data now.
    var sending = false;
    // A waiting queue for messages to be sent to the server.
    var queue = [];
    // For the client to send message to the server. In order to guarantee
    // message is sent in order, the above `sending` and `queue` are used.
    self.write = function(data) {
        // If `sending` is `false`, sets `sending` to `true` and sends `data`
        // immediately without going through the queue.
        if (!sending) {
            sending = true;
            send(data);
        // If not, adds `data` to the waiting queue. Then it will be sent
        // through the queue later.
        } else {
            queue.push(data);
        }

        function send(data) {
            var reqOpts = url.parse(uri);
            // Somehow it's turned out that KeepAlive Agent is required on
            // Node 4+.
            reqOpts.agent = new http.Agent({keepAlive: true});
            // Prepares for the request headers.
            reqOpts.headers = {};
            // `id` param should be added to query. As it has already
            // `transport` param, `&` can be preceded safely.
            reqOpts.path += "&id=" + encodeURIComponent(self.id);
            // The request's method should be `POST`.
            reqOpts.method = "POST";
            // Any error occurred when performing a request should propagate to
            // transport.
            function onerror(error) {
                self.emit("error", error);
            }
            // If the underlying connection of request-response was closed,
            // closes the connection this transport established if it is opened.
            function onclose() {
                if (self.opened) {
                    // It will fire `close` event finally.
                    self.close();
                }
            }
            // The server is supposed to send the response after reading the
            // request body.
            function onresponse() {
                // If there are pending data in the queue, removes the first one
                // from the queue and sends it one-by-one.
                if (queue.length) {
                    // FYI, `[1,2,3].shift()` returns in `1` and results in
                    // `[2,3]`.
                    send(queue.shift());
                // If not, set `false` to `sending` as all data in the waiting
                // queue are sent.
                } else {
                    sending = false;
                }
            }

            // `data` should be either a `Buffer` or a string.
            if (typeof data === "string") {
                // The content type header should be `text/plain; charset=utf-8`
                // for text message.
                reqOpts.headers["content-type"] = "text/plain; charset=utf-8";
                // The final body should be prefixed with `data=` and encoded in
                // `utf-8`.
                http.request(reqOpts).on("error", onerror).on("close", onclose).on("response", onresponse)
                .end("data=" + data, "utf-8");
            } else {
                // The content type header should be `application/octet-stream`
                // for binary message.
                reqOpts.headers["content-type"] = "application/octet-stream";
                http.request(reqOpts).on("error", onerror).on("close", onclose).on("response", onresponse)
                .end(data);
            }
        }
    };
    self.close = function() {
        // Aborts the real connection. `abort` should be implemented by others
        // and ensure that `close` event is fired.
        self.abort();
        // Server may not detect disconnection for some reason. Notifies the
        // server of disconnection of this connection to make sure. In this
        // request, `id` param should be added to query and `when` param should
        // be set to `abort`.
        var reqOpts = url.parse(uri + "&when=abort&id=" + encodeURIComponent(self.id));
        // Somehow it's turned out that KeepAlive Agent is required on Node 4+.
        reqOpts.agent = new http.Agent({keepAlive: true});
        http.request(reqOpts)
        // Node.js kills the process by default when an `error` event is fired
        // if there is no listener for it. However, a user doesn't need to be
        // notified of an error from this request as it is just for the server.
        .on("error", function() {}).end();
        return this;
    };
    return self;
};
