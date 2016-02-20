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

// This function is exposed to the module's `transport` module's
// `createHttpServer` as a factory to create server which consumes HTTP
// request-response exchange and produces transport.
module.exports = function() {
    // A transport server object.
    var self = new events.EventEmitter();
    // Since a HTTP transport consists of multiple HTTP exchanges, transport
    // object is needed to be retrieved using identifier.
    var transports = {};
    // When HTTP transport is opened,
    self.on("transport", function(transport) {
        // Adds it to the set by id.
        transports[transport.id] = transport;
        // And removes it from the set by id if it's closed.
        transport.on("close", function() {
            delete transports[transport.id];
        });
    });
    // A link between Cettia HTTP transport protocol and Node.js. `req` and
    // `res` are expected to be passed from Node.js's `http/https` module'
    // server' `request` event.
    self.handle = function(req, res) {
        req.params = url.parse(req.url, true).query;
        // Any request must not be cached.
        res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
        res.setHeader("pragma", "no-cache");
        res.setHeader("expires", "0");
        // Transports using `XDomainRequest` require CORS headers even in
        // same-origin connection.
        res.setHeader("access-control-allow-origin", req.headers.origin || "*");
        // As `content-type` header, `text/plain` for text message and
        // `application/octet-stream` for binary message are used. But, because
        // the latter is not said to be a "simple headers" defined by CORS spec,
        // `content-type` header should be listed as a value of
        // `access-control-allow-headers`.
        res.setHeader("access-control-allow-headers", "content-type");
        // For convenience.
        res.setHeader("access-control-allow-credentials", "true");
        switch (req.method) {
        // `OPTIONS` method is used to handle CORS preflight request. Since the
        // client needs to get `content-type` response header and it may be
        // `application/octet-stream` which is not "simple header" coined by
        // CORS spec, browser will perform this preflight request.
        case "OPTIONS":
            // Ends the response as necessary headers are already set.
            res.end();
            break;
        // `GET` method is used to establish a channel for the server to write
        // message to the client and manage existing transports.
        case "GET":
            // `when` param indicates a specific goal of `GET` request.
            switch (req.params.when) {
            // To establish a new channel.
            case "open":
                // `transport` param is transport name the client uses which
                // is either `stream` or `longpoll`.
                switch (req.params.transport) {
                case "stream":
                    self.emit("transport", createStreamTransport(req, res));
                    break;
                case "longpoll":
                    self.emit("transport", createLongpollTransport(req, res));
                    break;
                // For unknown transport param, responds with `501 Not
                // Implemented`.
                default:
                    res.statusCode = 501;
                    res.end();
                    break;
                }
                break;
            // To inject a new HTTP request-response exchange to long polling
            // transport.
            case "poll":
                // Finds the corresponding transport by `id` param.
                var transport = transports[req.params.id];
                if (transport) {
                    transport.refresh(req, res);
                } else {
                    // If there is no corresponding socket, responds with `500
                    // Internal Server Error`.
                    res.statusCode = 500;
                    res.end();
                }
                break;
            // To notify server of disconnection by client.
            case "abort":
                // Finds the corresponding transport by `id` param.
                var transport = transports[req.params.id];
                // If server detected disconnection correctly, `transport`
                // should have been null.
                if (transport) {
                    // For some reason, the server couldn't detect disconnection
                    // then close connection to fire `close` event to transport
                    // manually.
                    transport.close();
                }
                // In case of browser, it is performed by script tag so set
                // content-type header to `text/javascript` to avoid warning.
                res.setHeader("content-type", "text/javascript; charset=utf-8");
                res.end();
                break;
            // For unknown `when` param, responds with `501 Not Implemented`.
            default:
                res.statusCode = 501;
                res.end();
            }
            break;
        // `POST` method is used to establish a channel for the client to write
        // message to the server.
        case "POST":
            // Reads the request body.
            var chunks = [];
            req.on("data", function(chunk) {
                chunks.push(chunk);
            });
            req.on("end", function() {
                // Finds the corresponding transport by `id` param.
                var transport = transports[req.params.id];
                if (transport) {
                    // The complete body in the form of binary.
                    var body = Buffer.concat(chunks);
                    // Makes content-type header lowercase and verifies it.
                    switch ((req.headers["content-type"] || "").toLowerCase()) {
                    // A list of allowed content-type headers for text message.
                    case "text/plain; charset=utf-8":
                    case "text/plain; charset=utf8":
                    case "text/plain;charset=utf-8":
                    case "text/plain;charset=utf8":
                        // Fires `text` event by decoding the body with
                        // `utf-8` and stripping off leading `data=`.
                        transport.emit("text", body.toString("utf-8", "data=".length));
                        break;
                    // An allowed content-type header for binary message.
                    case "application/octet-stream":
                        // Fires `binary` event with the body.
                        transport.emit("binary", body);
                        break;
                    default:
                        // If the content-type header is invalid, fires an error
                        // and closes the connection.
                        transport.emit("error", new Error("protocol"));
                        transport.close();
                        // And responds with `500 Internal Server Error`.
                        res.statusCode = 500;
                        break;
                    }
                // If the specified transport is not found, responds with `500
                // Internal Server Error`. It might happen if the transport is
                // closed while reading request body.
                } else {
                    res.statusCode = 500;
                }
                // The response should end after processing the request body.
                res.end();
            });
            break;
        // If the method is neither `GET` nor `POST`, responds with `405 Method
        // Not Allowed`.
        default:
            res.statusCode = 405;
            res.end();
        }
    };
    return self;
};

// A base transport.
function createBaseTransport(req, res) {
    // A transport object.
    var self = new events.EventEmitter();
    // Because HTTP transport consists of multiple exchanges, an universally
    // unique identifier is required.
    self.id = uuid.v4();
    // Transport URI contains information like protocol header as query.
    self.uri = req.url;
    // A flag to check the transport is opened.
    var opened = true;
    self.on("close", function() {
        opened = false;
    });
    self.send = function(data) {
        // Allows to send data only it is opened. If not, fires an error.
        if (opened) {
            self.write(data);
        } else {
            self.emit("error", new Error("notopened"));
        }
        return this;
    };
    return self;
}

// The client performs a HTTP persistent connection and watches changes in
// response and the server prints chunk as data to response.
function createStreamTransport(req, res) {
    // A transport object.
    var self = createBaseTransport(req, res);
    // Any error on request-response should propagate to transport.
    req.on("error", function(error) {
        self.emit("error", error);
    });
    res.on("error", function(error) {
        self.emit("error", error);
    });
    // When the underlying connection was terminated abnormally.
    res.on("close", function() {
        self.emit("close");
    });
    // When the complete response has been sent.
    res.on("finish", function() {
        self.emit("close");
    });

    // The response body should be formatted in the [event stream
    // format](http://www.w3.org/TR/eventsource/#parsing-an-event-stream).
    self.write = function(data) {
        // `data` should be either a `Buffer` or a string.
        if (typeof data === "string") {
            // A text message should be prefixed with `1`.
            data = "1" + data;
        } else {
            // A binary message should be encoded in Base64 and prefixed with
            // `2`.
            data = "2" + data.toString("base64");
        }
        // According to the format, data should be broken up by `\r`, `\n`, or
        // `\r\n`.
        var payload = data.split(/\r\n|[\r\n]/).map(function(line) {
            // Each line should be prefixed with 'data: ' and postfixed with
            // `\n`.
            return "data: " + line + "\n";
        })
        // Prints `\n` as the last character of a message.
        .join("") + "\n";
        // Writes it to response with `utf-8` encoding.
        res.write(payload, "utf-8");
    };
    // Ends the response. Accordingly, `res`'s `finish` event will be fired.
    self.close = function() {
        res.end();
        return this;
    };

    // The content-type headers should be `text/event-stream` for Server-Sent
    // Events and `text/plain` for others. Also the response should be encoded in `utf-8`.
    res.setHeader("content-type", "text/" + 
        // If it's Server-Sent Events, `sse` param is `true`.
        (req.params.sse === "true" ? "event-stream" : "plain") + "; charset=utf-8");
    // The padding is required, which makes the client-side transport on old
    // browsers be aware of change of the response. It should be greater
    // than 1KB, be composed of white space character and end with `\n`.
    var text2KB = Array(2048).join(" ");
    // Some host objects which are used to perform streaming transport can't or
    // don't allow to read response headers as well as write request headers.
    // That's why we uses the first message as a handshake output. The handshake
    // result should be formatted in URI. And transport id should be added as
    // `id` param.
    var uri = url.format({query: {id: self.id}});
    // Likewise some host objects in old browsers, junk data is needed to make
    // themselves be aware of change of response. Prints the padding and the
    // first message following `text/event-stream` with `utf-8` encoding.
    res.write(text2KB + "\ndata: " + uri + "\n\n", "utf-8");
    return self;    
}

// The client performs a HTTP persistent connection and the server ends the
// response with data. Then, the client receives it and performs a request again
// and again.
function createLongpollTransport(req, res) {
    // The current response which can be used to send a message or close the
    // connection. It's not null when it's available and null when it's not
    // available.
    var response;
    // A flag to mark this transport is aborted. It's used when `response` is
    // not available, if user closes the connection.
    var aborted;
    // A timer to prevent from being idle connection which may happen if the
    // succeeding poll request is not arrived.
    var closeTimer;
    // The parameters of the first request. That of subsequent requests are not
    // used.
    var params = req.params;
    // A queue containing messages that the server couldn't send.
    var queue = [];
    // A transport object.
    var self = createBaseTransport(req, res);

    // In long polling, multiple HTTP exchanges are used to establish a channel
    // for the server to write message to client. This function will be called
    // every time the client performs a request.
    self.refresh = function(req, res) {
        // Any error on request-response should propagate to transport.
        req.on("error", function(error) {
            self.emit("error", error);
        });
        res.on("error", function(error) {
            self.emit("error", error);
        });
        // When the underlying connection was terminated abnormally.
        res.on("close", function() {
            self.emit("close");
        });
        // When the complete response has been sent.
        res.on("finish", function() {
            // If this request was to `poll` and this response was ended through
            // `end` not `endedWithMessage`, it means it is the end of the
            // transport. Hence, fires the `close` event.
            if (req.params.when === "poll" && !res.endedWithMessage) {
                self.emit("close");
            // Otherwise the client will issue `poll` request again. If not,
            // this connection falls into limbo. To prevent that, it sets a
            // timer which fires `close` event unless the client issues `poll`
            // request in 3s.
            } else {
                closeTimer = setTimeout(function() {
                    self.emit("close");
                }, 3000);
            }
        });
        // A custom property to show how it was ended through either
        // `endWithMessage` for sending a message or `end` for closing the
        // connection. An ended response can't be used again.
        res.endedWithMessage = false;
        // A custom method to send a message through this response.
        res.endWithMessage = function(data) {
            // Flags the current response is ended with message.
            res.endedWithMessage = true;
            // `data` should be either a `Buffer` or a string.
            if (typeof data === "string") {
                // As for text message, the content-type header should be
                // `text/javascript` for JSONP and `text/plain` for the others.
                res.setHeader("content-type", "text/" + 
                    // If it's JSONP, `jsonp` param is `true`.
                    (params.jsonp === "true" ? "javascript" : "plain") + "; charset=utf-8");
                // All the long polling transports have to finish the request
                // after processing. The `res`'s `finish` event will be fired
                // after this.
                res.end(params.jsonp === "true" ?
                    // In case of JSONP, the response text is supposed to be a
                    // JavaScript code executing a callback with data. The
                    // callback name is passed as the first request's `callback`
                    // param and the data to be returned have to be escaped to a
                    // JavaScript string literal. For others, no formatting is
                    // needed. In any case, data should be encoded in `utf-8`.
                    params.callback + "(" + JSON.stringify(data) + ");" : data, "utf-8");
            } else {
                // As for binary message, the content-type header should be
                // `application/octet-stream`.
                res.setHeader("content-type", "application/octet-stream");
                res.end(data);
            }
        };
        switch (req.params.when) {
        // The first request
        case "open":
            // `script` tag which is a host object used in old browsers to
            // perform long polling transport can't read response headers as
            // well as write request headers. That's why we uses the first
            // response's body as a handshake output instead of headers. The
            // handshake result should be formatted in URI. And transport id
            // should be added as `id` param.
            res.endWithMessage(url.format({query: {id: self.id}}));
            break;
        // The succeeding request after the first request
        case "poll":
            // Resets timer as new exchange is supplied.
            clearTimeout(closeTimer);
            // If aborted is `true` here, it means the user tried to close the
            // connection but it couldn't be done because `response` was null.
            // So ends this incoming exchange. It will fire `close` event
            // through `res`'s `finish` event handler.
            if (aborted) {
                res.end();
            } else {
                // If the queue is not empty, it means there are remaining
                // messages so that the server should send them again.
                if (queue.length) {
                    // Removes the first cached message from the queue and send
                    // it. FYI, `[1,2,3].shift()` returns in `1` and results in
                    // `[2,3]`.
                    res.endWithMessage(queue.shift());
                } else {
                    // If not, assigns `res` to `response`.
                    response = res;
                }
            }
            break;
        // If this function complies to the contract, it shouldn't happen.
        default:
            self.emit("error", new Error("protocol"));
            self.close();
            break;
        }
    };
    self.write = function(data) {
        // Only when the current response exists, it's possible to send a
        // message.
        if (response) {
            // After `response.endWithMessage`, `response` can't be used again.
            var resp = response;
            response = null;
            resp.endWithMessage(data);
        // If not, the data will be cached and sent in next poll through
        // `refresh` method.
        } else {
            queue.push(data);
        }
    };
    self.close = function() {
        // Only when the current response exists, it's possible to close the
        // connection.
        if (response) {
            // After `response.end`, `response` can't be used again.
            var resp = response;
            response = null;
            resp.end();
        // If not, a next poll request will be ended immediately by `aborted`
        // flag through `refresh` method.
        } else {
            aborted = true;
        }
        return this;
    };
    // Refreshes with the first exchange.
    self.refresh(req, res);
    return self;
}
