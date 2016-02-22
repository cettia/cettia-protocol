var parseArgs = require("minimist");
var should = require("chai").should();
var url = require("url");
var http = require("http");
var querystring = require("querystring");
var crypto = require("crypto");
var cettia = require("../lib/index");

http.globalAgent.maxSockets = Infinity;

// A factory to create a group of test
var factory = {
  args: parseArgs(process.argv, {
    default: {
      "cettia.transports": ""
    }
  }).cettia,
  create: function(title, fn) {
    describe(title, function() {
      // Per transport
      factory.args.transports.split(",").forEach(function(transport) {
        var args = {transport: transport};
        it(transport, function(done) {
          this.args = args;
          fn.apply(this, arguments);
        });
      });
    });
  }
};

describe("client", function() {
  this.timeout(30 * 1000);

  var origin = "http://localhost:9000";
  // To be destroyed
  var sockets = [];
  var netSockets = [];
  // A Cettia server
  var server = cettia.createServer();
  server.on("socket", function(socket) {
    sockets.push(socket);
    socket.on("close", function() {
      sockets.splice(sockets.indexOf(socket), 1);
    });
  });
  // An HTTP server to install Cettia server
  var httpServer = http.createServer();
  httpServer.on("connection", function(socket) {
    netSockets.push(socket);
    socket.on("close", function() {
      netSockets.splice(netSockets.indexOf(socket), 1);
    });
  });
  var httpTransportServer = cettia.transport.createHttpServer();
  httpTransportServer.on("transport", server.handle);
  httpServer.on("request", function(req, res) {
    if (url.parse(req.url).pathname === "/cettia") {
      httpTransportServer.handle(req, res);
    }
  });
  var wsTransportServer = cettia.transport.createWebSocketServer();
  wsTransportServer.on("transport", server.handle);
  httpServer.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/cettia") {
      wsTransportServer.handle(req, sock, head);
    }
  });

  function run(options) {
    server.setHeartbeat(options.heartbeat || 20000);
    server.set_heartbeat(options._heartbeat || 5000);
    var params = {
      uri: "http://localhost:" + httpServer.address().port + "/cettia"
    };
    // TODO improve
    switch (options.transport) {
      case "websocket":
        params.uri = params.uri.replace(/^http/, "ws");
        break;
      case "httpstream":
        params.uri += "?transport=stream";
        break;
      case "httplongpoll":
        params.uri += "?transport=longpoll";
        break;
      default:
        throw new Error("Unsupported transport");
        break;
    }
    // To test multiple clients concurrently
    if (factory.args.session) {
      params.session = factory.args.session;
    }
    http.get(origin + "/open?" + querystring.stringify(params));
  }

  before(function(done) {
    httpServer.listen(0, function() {
      done();
    });
  });
  after(function(done) {
    // To shutdown the web server immediately
    netSockets.forEach(function(socket) {
      socket.destroy();
    });
    httpServer.close(function() {
      done();
    });
  });
  beforeEach(function() {
    // To restore the original stack
    this.socketListeners = server.listeners("socket");
  });
  afterEach(function() {
    // Remove the listener added by the test and restore the original stack
    server.removeAllListeners("socket");
    this.socketListeners.forEach(server.on.bind(server, "socket"));
    // To release stress of browsers, clean sockets
    sockets.forEach(function(socket) {
      socket.close();
    });
  });

  factory.create("should open a new socket", function(done) {
    server.on("socket", function(socket) {
      done();
    });
    run({transport: this.args.transport});
  });
  factory.create("should close the socket", function(done) {
    server.on("socket", function(socket) {
      socket.on("open", function() {
        socket.send("abort");
      });
      socket.on("close", function() {
        done();
      });
    });
    run({transport: this.args.transport});
  });
  factory.create("should exchange an event", function(done) {
    server.on("socket", function(socket) {
      socket.on("open", function() {
        socket.send("echo", "data");
      });
      socket.on("echo", function(data) {
        data.should.be.equal("data");
        done();
      });
    });
    run({transport: this.args.transport});
  });
  factory.create("should exchange an event containing of multi-byte characters", function(done) {
    server.on("socket", function(socket) {
      socket.on("open", function() {
        socket.send("echo", "라면");
      });
      socket.on("echo", function(data) {
        data.should.be.equal("라면");
        done();
      });
    });
    run({transport: this.args.transport});
  });
  factory.create("should exchange an event of 2KB", function(done) {
    var text2KB = Array(2048).join("K");
    server.on("socket", function(socket) {
      socket.on("open", function() {
        socket.send("echo", text2KB);
      });
      socket.on("echo", function(data) {
        data.should.be.equal(text2KB);
        done();
      });
    });
    run({transport: this.args.transport});
  });
  factory.create("should not lose any event in an exchange of twenty events", function(done) {
    var timer, sent = [], received = [];
    server.on("socket", function(socket) {
      socket.on("open", function() {
        for (var i = 0; i < 20; i++) {
          sent.push(i);
          socket.send("echo", i);
        }
      });
      socket.on("echo", function(i) {
        received.push(i);
        clearTimeout(timer);
        timer = setTimeout(function() {
          received.should.be.deep.equal(sent);
          done();
        }, received.length === 20 ? 0 : 5000);
      });
    });
    run({transport: this.args.transport});
  });
  factory.create("should close the socket if heartbeat fails", function(done) {
    server.on("socket", function(socket) {
      // Breaks heartbeat functionality
      socket.send = function() {
        return this;
      };
      socket.on("error", function() {
      })
      .on("close", function() {
        done();
      });
    });
    run({transport: this.args.transport, heartbeat: 2500, _heartbeat: 2400});
  });
  describe("reply", function() {
    factory.create("should execute the resolve callback when receiving event", function(done) {
      server.on("socket", function(socket) {
        socket.on("open", function() {
          socket.send("/reply/inbound", {type: "resolved", data: Math.PI}, function(value) {
            value.should.be.equal(Math.PI);
            done();
          }, function() {
            true.should.be.false;
          });
        });
      });
      run({transport: this.args.transport});
    });
    factory.create("should execute the reject callback when receiving event", function(done) {
      server.on("socket", function(socket) {
        socket.on("open", function() {
          socket.send("/reply/inbound", {type: "rejected", data: Math.PI}, function() {
            true.should.be.false;
          }, function(value) {
            value.should.be.equal(Math.PI);
            done();
          });
        });
      });
      run({transport: this.args.transport});
    });
    factory.create("should execute the resolve callback when sending event", function(done) {
      server.on("socket", function(socket) {
        socket.on("open", function() {
          socket.send("/reply/outbound", {type: "resolved", data: Math.E});
        });
        socket.on("test", function(data, reply) {
          reply.resolve(data);
          this.on("done", function(value) {
            value.should.be.equal(Math.E);
            done();
          });
        });
      });
      run({transport: this.args.transport});
    });
    factory.create("should execute the reject callback when sending event", function(done) {
      server.on("socket", function(socket) {
        socket.on("open", function() {
          socket.send("/reply/outbound", {type: "rejected", data: Math.E})
        });
        socket.on("test", function(data, reply) {
          reply.reject(data);
          this.on("done", function(value) {
            value.should.be.equal(Math.E);
            done();
          });
        });
      });
      run({transport: this.args.transport});
    });
  });
});
