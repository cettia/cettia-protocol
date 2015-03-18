var cettia = require("../../lib/index");
var url = require("url");
var http = require("http");

var server = cettia.createServer();
server.on("socket", function(socket) {
    socket.on("error", function() {})
    .on("abort", function() {
        this.close();
    })
    .on("echo", function(data) {
        socket.send("echo", data);
    });
    // reply
    socket.on("/reply/inbound", function(data, reply) {
        switch (data.type) {
        case "resolved":
            reply.resolve(data.data);
            break;
        case "rejected":
            reply.reject(data.data);
            break;
        }
    })
    .on("/reply/outbound", function(data) {
        switch (data.type) {
        case "resolved":
            this.send("test", data.data, function(data) {
                this.send("done", data);
            });
            break;
        case "rejected":
            this.send("test", data.data, null, function(data) {
                this.send("done", data);
            });
            break;
        }
    });
});

var httpServer = http.createServer();
var httpTransportServer = cettia.transport.createHttpServer();
httpTransportServer.on("transport", server.handle);
httpServer.on("request", function(req, res) {
    var urlObj = url.parse(req.url, true);
    var query = urlObj.query;
    switch (urlObj.pathname) {
    case "/setup":
        if (query.heartbeat) {
            server.setHeartbeat(+query.heartbeat);
        }
        if (query._heartbeat) {
            server.set_heartbeat(+query._heartbeat);
        }
        res.end();
        break;
    case "/cettia":
        httpTransportServer.handle(req, res);
        break;
    }
});
var wsTransportServer = cettia.transport.createWebSocketServer();
wsTransportServer.on("transport", server.handle);
httpServer.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/cettia") {
        wsTransportServer.handle(req, sock, head);
    }
});
httpServer.listen(8000);