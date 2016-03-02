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
  })
    .cettia,
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

describe("server", function() {
  this.timeout(30 * 1000);

  var origin = "http://localhost:8000";
  // To be destroyed
  var sockets = [];

  function open(options, fn) {
    http.get(origin + "/setup?" + querystring.stringify({
        heartbeat: options.heartbeat || 20000,
        _heartbeat: options._heartbeat || 5000
      }), function() {
      // Start a test after completing setup
      // TODO improve
      var uri = origin + "/cettia";
      switch (options.transport) {
        case "websocket":
          uri = uri.replace(/^http/, "ws");
          break;
        case "httpstream":
          uri += "?transport=stream";
          break;
        case "httplongpoll":
          uri += "?transport=longpoll";
          break;
        default:
          throw new Error("Unsupported transport");
          break;
      }
      var socket = cettia.open(uri)
      .on("open", function() {
        sockets.push(this);
      })
      .on("close", function() {
        sockets.splice(sockets.indexOf(this), 1);
      });
      fn(socket);
    });
  }

  afterEach(function() {
    // To release stress of server and exit node process properly, clean
    // sockets
    sockets.forEach(function(socket) {
      socket.close();
    });
  });

  factory.create("should accept a new socket", function(done) {
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        done();
      });
    });
  });
  factory.create("should close the socket", function(done) {
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        this.send("abort");
      })
      .on("close", function() {
        done();
      });
    });
  });
  factory.create("should exchange a text event", function(done) {
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        this.send("echo", "data");
      })
      .on("echo", function(data) {
        data.should.be.equal("data");
        done();
      });
    });
  });
  factory.create("should exchange a binary event", function(done) {
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        this.send("echo", Buffer("data"));
      })
      .on("echo", function(data) {
        data.should.be.deep.equal(Buffer("data"));
        done();
      });
    });
  });
  factory.create("should exchange a composite event", function(done) {
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        this.send("echo", {text: "data", binary: Buffer("data")});
      })
      .on("echo", function(data) {
        data.should.be.deep.equal({text: "data", binary: Buffer("data")});
        done();
      });
    });
  });
  factory.create("should exchange an event containing of multi-byte characters", function(done) {
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        this.send("echo", "라면");
      })
      .on("echo", function(data) {
        data.should.be.equal("라면");
        done();
      });
    });
  });
  factory.create("should exchange an event of 2KB", function(done) {
    var text2KB = Array(2048).join("K");
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        this.send("echo", text2KB);
      })
      .on("echo", function(data) {
        data.should.be.equal(text2KB);
        done();
      });
    });
  });
  factory.create("should not lose any event in an exchange of twenty events", function(done) {
    var timer, sent = [], received = [];
    open({transport: this.args.transport}, function(socket) {
      socket.on("open", function() {
        var self = this;
        for (var i = 0; i < 20; i++) {
          sent.push(i);
          self.send("echo", i);
        }
      })
      .on("echo", function(i) {
        received.push(i);
        clearTimeout(timer);
        timer = setTimeout(function() {
          received.should.be.deep.equal(sent);
          done();
        }, received.length === 20 ? 0 : 5000);
      });
    });
  });
  factory.create("should close the socket if heartbeat fails", function(done) {
    open({transport: this.args.transport, heartbeat: 2500, _heartbeat: 2400}, function(socket) {
      socket.on("open", function() {
        // Breaks heartbeat functionality
        this.send = function() {
          return this;
        };
      })
      .on("error", function() {
      })
      .on("close", function() {
        done();
      });
    });
  });
  describe("reply", function() {
    factory.create("should execute the resolve callback in receiving event", function(done) {
      open({transport: this.args.transport}, function(socket) {
        socket.on("open", function() {
          this.send("/reply/inbound", {type: "resolved", data: Math.PI}, function(value) {
            value.should.be.equal(Math.PI);
            done();
          }, function() {
            true.should.be.false;
          });
        });
      });
    });
    factory.create("should execute the reject callback in receiving event", function(done) {
      open({transport: this.args.transport}, function(socket) {
        socket.on("open", function() {
          this.send("/reply/inbound", {type: "rejected", data: Math.PI}, function() {
            true.should.be.false;
          }, function(value) {
            value.should.be.equal(Math.PI);
            done();
          });
        });
      });
    });
    factory.create("should execute the resolve callback in sending event", function(done) {
      open({transport: this.args.transport}, function(socket) {
        socket.on("open", function() {
          this.send("/reply/outbound", {type: "resolved", data: Math.E});
        })
        .on("test", function(data, reply) {
          reply.resolve(data);
          this.on("done", function(value) {
            value.should.be.equal(Math.E);
            done();
          });
        });
      });
    });
    factory.create("should execute the reject callback in sending event", function(done) {
      open({transport: this.args.transport}, function(socket) {
        socket.on("open", function() {
          this.send("/reply/outbound", {type: "rejected", data: Math.E});
        })
        .on("test", function(data, reply) {
          reply.reject(data);
          this.on("done", function(value) {
            value.should.be.equal(Math.E);
            done();
          });
        });
      });
    });
  });
});
